// Ordinary same-token child/job ownership for a disposable native lifecycle probe.
// No account, credential, token-filtering, ACL, desktop-DACL, or host-policy changes.
// Native compilation/execution is still required; this is not validation evidence.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Collections.Generic;

public sealed class LifecycleProcessOwner : IDisposable
{
    const uint CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO
    {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reserved2; public IntPtr reserved2Pointer, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION
    { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT
    {
        public long perProcessUserTime, perJobUserTime; public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet; public uint activeProcessLimit;
        public UIntPtr affinity; public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS
    { public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT
    { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct JOB_ACCOUNTING
    {
        public long totalUserTime, totalKernelTime, thisPeriodUserTime, thisPeriodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOB_BASIC_AND_IO
    { public JOB_ACCOUNTING basic; public IO_COUNTERS io; }
    public sealed class Accounting
    {
        public uint ActiveProcesses, TotalProcesses, TerminatedProcesses;
        public double CpuSeconds;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    static extern bool QueryAccounting(IntPtr job, int kind, out JOB_BASIC_AND_IO info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out JOB_ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    static extern bool QueryProcessIds(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    IntPtr job;
    PROCESS_INFORMATION child;
    bool resumed;
    public Process Process { get; private set; }
    static void Require(bool ok, string stage)
    { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), stage); }
    void RequireOpen() { if (job == IntPtr.Zero) throw new ObjectDisposedException("LifecycleProcessOwner"); }

    // The caller records the actual child token and checks mode while it is suspended.
    // A denied job assignment stops here, before any installer/application code runs.
    public static LifecycleProcessOwner StartSuspended(string executable, string arguments, string directory, string[] pairs)
    {
        if (!Path.IsPathRooted(executable) || !File.Exists(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            || executable.IndexOf('"') >= 0 || executable.IndexOf('\0') >= 0)
            throw new ArgumentException("Existing absolute native .exe required");
        if (!Path.IsPathRooted(directory) || !Directory.Exists(directory) || (arguments ?? "").IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid working directory or argument tail");
        if (pairs == null || pairs.Length == 0) throw new ArgumentException("Explicit non-secret environment required");
        string[] environment = (string[])pairs.Clone();
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string pair in environment)
        {
            int equal = pair == null ? -1 : pair.IndexOf('=');
            if (equal <= 0 || pair.IndexOf('\0') >= 0 || !names.Add(pair.Substring(0, equal)))
                throw new ArgumentException("Invalid or duplicate environment entry");
        }
        Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
        IntPtr block = Marshal.StringToHGlobalUni(string.Join("\0", environment) + "\0\0");
        LifecycleProcessOwner owner = new LifecycleProcessOwner();
        bool assigned = false;
        try
        {
            owner.job = CreateJobObject(IntPtr.Zero, null); Require(owner.job != IntPtr.Zero, "Create lifecycle job");
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = KILL_ON_JOB_CLOSE;
            Require(SetInformationJobObject(owner.job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Set lifecycle job limits");
            STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            Require(CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + (arguments ?? "")),
                IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                block, directory, ref startup, out owner.child), "Create same-token lifecycle child suspended");
            Require(AssignProcessToJobObject(owner.job, owner.child.process), "Assign lifecycle child to owned job");
            assigned = true;
            owner.Process = System.Diagnostics.Process.GetProcessById(checked((int)owner.child.processId));
            // Retain a managed handle so .NET can still read ExitCode after exit.
            if (owner.Process.Handle == IntPtr.Zero) throw new InvalidOperationException("Managed lifecycle process handle is missing");
            return owner;
        }
        catch
        {
            if (!assigned && owner.child.process != IntPtr.Zero) TerminateProcess(owner.child.process, 0xdead);
            owner.Dispose();
            throw;
        }
        finally { Marshal.FreeHGlobal(block); }
    }
    public void Resume()
    {
        RequireOpen();
        if (resumed) throw new InvalidOperationException("Lifecycle child was already resumed");
        Require(ResumeThread(child.thread) != 0xffffffff, "Resume observed lifecycle child");
        resumed = true;
    }
    public uint ActiveProcessCount
    {
        get
        {
            RequireOpen(); JOB_ACCOUNTING info;
            Require(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(JOB_ACCOUNTING)), IntPtr.Zero), "Read lifecycle job accounting");
            return info.activeProcesses;
        }
    }
    // Monotonic native job totals include already-exited descendants.
    // Read-only observation; no changes to limits, membership, tokens or cleanup.
    public Accounting AccountingSnapshot()
    {
        RequireOpen(); JOB_BASIC_AND_IO info;
        Require(QueryAccounting(job, 8, out info, (uint)Marshal.SizeOf(typeof(JOB_BASIC_AND_IO)), IntPtr.Zero), "Read lifecycle job CPU and IO accounting");
        return new Accounting { ActiveProcesses=info.basic.activeProcesses, TotalProcesses=info.basic.totalProcesses,
            TerminatedProcesses=info.basic.terminatedProcesses, CpuSeconds=(info.basic.totalUserTime+info.basic.totalKernelTime)/10000000.0,
            ReadOperations=info.io.readOperations, WriteOperations=info.io.writeOperations, OtherOperations=info.io.otherOperations,
            ReadBytes=info.io.readBytes, WriteBytes=info.io.writeBytes, OtherBytes=info.io.otherBytes };
    }
    public int[] ProcessIds()
    {
        RequireOpen();
        for (int capacity = 64; capacity <= 1048576; capacity *= 2)
        {
            int size = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryProcessIds(job, 3, buffer, (uint)size, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 234) continue; // Membership grew; retry a larger read.
                    throw new Win32Exception(error, "Read lifecycle job process IDs");
                }
                int count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > capacity) throw new InvalidOperationException("Invalid lifecycle job process count");
                int[] ids = new int[count];
                for (int i = 0; i < count; i++) ids[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                return ids;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Lifecycle job membership exceeds the bounded observation buffer");
    }
    public bool WaitForEmpty(int timeoutMilliseconds)
    {
        Stopwatch timer = Stopwatch.StartNew();
        do
        {
            if (ActiveProcessCount == 0) return true;
            if (timer.ElapsedMilliseconds >= timeoutMilliseconds) return false;
            Thread.Sleep(50);
        } while (true);
    }
    public void Terminate()
    { RequireOpen(); Require(TerminateJobObject(job, 0xdead), "Terminate only owned lifecycle job"); }
    public void Dispose()
    {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (child.thread != IntPtr.Zero) { CloseHandle(child.thread); child.thread = IntPtr.Zero; }
        if (child.process != IntPtr.Zero) { CloseHandle(child.process); child.process = IntPtr.Zero; }
        if (Process != null) { Process.Dispose(); Process = null; }
    }
}
