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
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, WAIT_FAILED = 0xffffffff;
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
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr size, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
    public class WindowEvidence { public int Pid; public string Handle; public string[] Text; }
    public static WindowEvidence[] ReadOwnedWindowText(int[] processIds)
    {
        var ids = new HashSet<int>(processIds); var rows = new List<WindowEvidence>();
        var timer = Stopwatch.StartNew();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (timer.ElapsedMilliseconds >= 2000 || rows.Count >= 20) return false;
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (!ids.Contains((int)pid)) return true;
            var texts = new List<string>();
            EnumWindow read = delegate(IntPtr control, IntPtr unused)
            {
                if (timer.ElapsedMilliseconds >= 2000 || texts.Count >= 64) return false;
                var text = new StringBuilder(1024); UIntPtr result;
                // Bounded WM_GETTEXT can read standard dialog controls across processes;
                // a hidden or hung installer must not hang diagnostic collection itself.
                if (SendMessageTimeout(control, 0x000d, (UIntPtr)text.Capacity, text, 2, 100, out result) != IntPtr.Zero && text.Length != 0)
                    texts.Add(text.ToString());
                return true;
            };
            read(window, IntPtr.Zero); EnumChildWindows(window, read, IntPtr.Zero);
            rows.Add(new WindowEvidence { Pid = (int)pid, Handle = window.ToInt64().ToString(), Text = texts.ToArray() });
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    IntPtr job;
    PROCESS_INFORMATION child;
    bool resumed;
    // CreateProcess already returned a usable creator handle. Process.Handle would
    // reopen by PID with ALL_ACCESS, which a filtered medium token can be denied.
    public sealed class NativeChild
    {
        readonly LifecycleProcessOwner owner;
        internal NativeChild(LifecycleProcessOwner value) { owner = value; }
        IntPtr Handle
        {
            get
            {
                if (owner.child.process == IntPtr.Zero) throw new ObjectDisposedException("Lifecycle native child");
                return owner.child.process;
            }
        }
        public int Id { get { return checked((int)owner.child.processId); } }
        public bool WaitForExit(int milliseconds)
        {
            if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
            uint result = WaitForSingleObject(Handle, (uint)milliseconds);
            Require(result != WAIT_FAILED, "WaitForSingleObject lifecycle child");
            if (result == WAIT_OBJECT_0) return true;
            if (result == WAIT_TIMEOUT) return false;
            throw new InvalidOperationException("Unexpected lifecycle child wait status: " + result);
        }
        public bool HasExited { get { return WaitForExit(0); } }
        public int ExitCode
        {
            get
            {
                if (!HasExited) throw new InvalidOperationException("Lifecycle child has not exited");
                uint code;
                Require(GetExitCodeProcess(Handle, out code), "GetExitCodeProcess lifecycle child");
                return unchecked((int)code);
            }
        }
    }
    public sealed class StartEvidence
    {
        public string Stage { get; set; }
        public int ProcessId { get; set; }
        public bool Assigned { get; set; }
        public int? Win32Error { get; set; }
        public bool FailedStartChildExited { get; set; }
        public bool FailedStartJobEmpty { get; set; }
        public string CleanupError { get; set; }
    }
    // This QA helper has one launching caller; each attempt replaces its diagnostic.
    public static StartEvidence LastStartEvidence { get; private set; }
    public NativeChild Process { get; private set; }
    static void Require(bool ok, string stage)
    {
        if (!ok)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, stage + " failed (Win32 " + error + "): " + new Win32Exception(error).Message);
        }
    }
    void RequireOpen() { if (job == IntPtr.Zero) throw new ObjectDisposedException("LifecycleProcessOwner"); }

    // The caller records the actual child token and checks mode while it is suspended.
    // A denied job assignment stops here, before any installer/application code runs.
    public static LifecycleProcessOwner StartSuspended(string executable, string arguments, string directory, string[] pairs)
    { return StartCore(executable, arguments, directory, pairs, false); }

    // Test-only fault injection uses a suspended synthetic child, never product code.
    public static void FailAfterAssignmentForSelfTest(string executable, string arguments, string directory, string[] pairs)
    { StartCore(executable, arguments, directory, pairs, true); }

    static LifecycleProcessOwner StartCore(string executable, string arguments, string directory, string[] pairs, bool failAfterAssignment)
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
        LastStartEvidence = new StartEvidence();
        try
        {
            LastStartEvidence.Stage = "CreateJobObject";
            owner.job = CreateJobObject(IntPtr.Zero, null); Require(owner.job != IntPtr.Zero, "Create lifecycle job");
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = KILL_ON_JOB_CLOSE;
            LastStartEvidence.Stage = "SetInformationJobObject";
            Require(SetInformationJobObject(owner.job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Set lifecycle job limits");
            STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            LastStartEvidence.Stage = "CreateProcessW";
            Require(CreateProcessW(executable, new StringBuilder("\"" + executable + "\" " + (arguments ?? "")),
                IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                block, directory, ref startup, out owner.child), "Create same-token lifecycle child suspended");
            LastStartEvidence.ProcessId = checked((int)owner.child.processId);
            LastStartEvidence.Stage = "AssignProcessToJobObject";
            Require(AssignProcessToJobObject(owner.job, owner.child.process), "Assign lifecycle child to owned job");
            assigned = true;
            LastStartEvidence.Assigned = true;
            LastStartEvidence.Stage = "retain-creator-process-handle";
            owner.Process = new NativeChild(owner);
            if (failAfterAssignment) throw new InvalidOperationException("Injected failure after suspended child assignment");
            LastStartEvidence.Stage = "suspended-child-ready";
            return owner;
        }
        catch (Exception error)
        {
            var win32 = error as Win32Exception;
            if (win32 != null) LastStartEvidence.Win32Error = win32.NativeErrorCode;
            var cleanupErrors = new List<string>();
            // Attempt child and job termination independently. A racing child exit
            // must not skip the owned-job cleanup or its bounded observation.
            try
            {
                // An assigned nested job must not rely only on close-time cleanup:
                // explicitly stop and observe our original handle before returning.
                if (owner.child.process != IntPtr.Zero)
                {
                    uint wait = WaitForSingleObject(owner.child.process, 0);
                    Require(wait != WAIT_FAILED, "WaitForSingleObject failed-start child");
                    if (wait != WAIT_OBJECT_0) Require(TerminateProcess(owner.child.process, 0xdead), "TerminateProcess failed-start child");
                }
            }
            catch (Exception cleanup) { cleanupErrors.Add(cleanup.Message); }
            try
            {
                if (assigned)
                {
                    Require(TerminateJobObject(owner.job, 0xdead), "TerminateJobObject failed-start child");
                }
            }
            catch (Exception cleanup) { cleanupErrors.Add(cleanup.Message); }
            try
            {
                LastStartEvidence.FailedStartChildExited = owner.child.process == IntPtr.Zero ||
                    WaitForSingleObject(owner.child.process, 5000) == WAIT_OBJECT_0;
                LastStartEvidence.FailedStartJobEmpty = !assigned || owner.WaitForEmpty(5000);
                if (!LastStartEvidence.FailedStartChildExited || !LastStartEvidence.FailedStartJobEmpty)
                    cleanupErrors.Add("Failed-start child or job did not finish within cleanup bound");
            }
            catch (Exception cleanup) { cleanupErrors.Add(cleanup.Message); }
            if (cleanupErrors.Count != 0) LastStartEvidence.CleanupError = string.Join("; ", cleanupErrors);
            owner.Dispose();
            throw new InvalidOperationException("Lifecycle startup failed at " + LastStartEvidence.Stage + ": " + error.Message +
                (LastStartEvidence.CleanupError == null ? "; failed-start child and job cleanup observed" : "; cleanup failed: " + LastStartEvidence.CleanupError), error);
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
        Process = null;
    }
}
