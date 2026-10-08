// Draft, reviewed against Microsoft Win32 contracts. NOT compiled or run on Windows.
// Process-local filtering only. This is not a standard-account or sandbox proof.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class RestrictedTokenLauncher
{
    const uint TOKEN_QUERY = 8, TOKEN_DUPLICATE = 2, TOKEN_ASSIGN_PRIMARY = 1;
    const uint TOKEN_IMPERSONATE = 4, TOKEN_ADJUST_DEFAULT = 0x80;
    const uint LUA_TOKEN = 4, GROUP_ENABLED = 4, GROUP_DENY_ONLY = 0x10;
    const uint CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, WAIT_FAILED = 0xffffffff;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int TokenUser = 1, TokenGroups = 2, TokenPrivileges = 3;
    const int TokenElevationType = 18, TokenElevation = 20, TokenHasRestrictions = 21;
    const int TokenIntegrityLevel = 25, TokenUIAccess = 26;

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
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

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int kind, IntPtr b, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr t, int kind, IntPtr b, int size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr t, uint flags, uint disabledCount,
        [In] SID_AND_ATTRIBUTES[] disabled, uint deletedCount, [In] LUID_AND_ATTRIBUTES[] deleted,
        uint restrictingCount, IntPtr restricting, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeName(string system, ref LUID luid, StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr t, string app,
        StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out JOB_ACCOUNTING info, uint size, IntPtr returned);

    public class GroupEvidence { public string Sid; public uint Attributes; }
    public class PrivilegeEvidence { public string Name; public uint Attributes; }
    public class TokenEvidence
    {
        public string UserSid, IntegritySid;
        public uint IsElevated, ElevationType, HasRestrictions, UIAccess;
        public GroupEvidence[] Groups;
        public PrivilegeEvidence[] Privileges;
    }
    public class LaunchEvidence
    {
        public string Coverage = "same-runner-user restricted-token subprocess; not a separate standard account";
        public string Stage;
        public TokenEvidence Source, Prepared, Child;
        public uint ChildProcessId, ExitCode;
        public bool TokenGatePassed, ProcessTreeFinished;
    }
    // Single-invocation helper: lets the PowerShell consumer preserve evidence on failure.
    public static LaunchEvidence LastEvidence;

    static void Win32(bool success, string stage)
    { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), stage); }
    static IntPtr Read(IntPtr token, int kind)
    {
        int n;
        bool ok = GetTokenInformation(token, kind, IntPtr.Zero, 0, out n);
        if (!ok && Marshal.GetLastWin32Error() != 122) Win32(false, "GetTokenInformation size " + kind);
        if (n <= 0) throw new InvalidOperationException("Empty token information: " + kind);
        IntPtr p = Marshal.AllocHGlobal(n);
        try { Win32(GetTokenInformation(token, kind, p, n, out n), "GetTokenInformation " + kind); return p; }
        catch { Marshal.FreeHGlobal(p); throw; }
    }
    static uint Dword(IntPtr token, int kind)
    { IntPtr p = Read(token, kind); try { return unchecked((uint)Marshal.ReadInt32(p)); } finally { Marshal.FreeHGlobal(p); } }
    static string Sid(IntPtr p) { return new SecurityIdentifier(p).Value; }
    static string TokenSid(IntPtr token, int kind)
    { IntPtr p = Read(token, kind); try { return Sid(Marshal.ReadIntPtr(p)); } finally { Marshal.FreeHGlobal(p); } }
    static GroupEvidence[] Groups(IntPtr token)
    {
        IntPtr p = Read(token, TokenGroups);
        try
        {
            int count = Marshal.ReadInt32(p), offset = IntPtr.Size == 8 ? 8 : 4;
            int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            GroupEvidence[] groups = new GroupEvidence[count];
            for (int i = 0; i < count; i++)
            {
                SID_AND_ATTRIBUTES g = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(p, offset + i * stride), typeof(SID_AND_ATTRIBUTES));
                groups[i] = new GroupEvidence { Sid = Sid(g.Sid), Attributes = g.Attributes };
            }
            return groups;
        }
        finally { Marshal.FreeHGlobal(p); }
    }
    static string PrivilegeName(LUID luid)
    {
        uint n = 0; LookupPrivilegeName(null, ref luid, null, ref n);
        if (n == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "LookupPrivilegeName size");
        StringBuilder name = new StringBuilder((int)n + 1); n++;
        Win32(LookupPrivilegeName(null, ref luid, name, ref n), "LookupPrivilegeName");
        return name.ToString();
    }
    static LUID_AND_ATTRIBUTES[] PrivilegeEntries(IntPtr token)
    {
        IntPtr p = Read(token, TokenPrivileges);
        try
        {
            int count = Marshal.ReadInt32(p), stride = Marshal.SizeOf(typeof(LUID_AND_ATTRIBUTES));
            LUID_AND_ATTRIBUTES[] entries = new LUID_AND_ATTRIBUTES[count];
            for (int i = 0; i < count; i++) entries[i] = (LUID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(p, 4 + i * stride), typeof(LUID_AND_ATTRIBUTES));
            return entries;
        }
        finally { Marshal.FreeHGlobal(p); }
    }
    static TokenEvidence Snapshot(IntPtr token)
    {
        List<PrivilegeEvidence> privileges = new List<PrivilegeEvidence>();
        foreach (LUID_AND_ATTRIBUTES entry in PrivilegeEntries(token))
            privileges.Add(new PrivilegeEvidence { Name = PrivilegeName(entry.Luid), Attributes = entry.Attributes });
        return new TokenEvidence { UserSid = TokenSid(token, TokenUser), IntegritySid = TokenSid(token, TokenIntegrityLevel),
            IsElevated = Dword(token, TokenElevation), ElevationType = Dword(token, TokenElevationType),
            HasRestrictions = Dword(token, TokenHasRestrictions), UIAccess = Dword(token, TokenUIAccess),
            Groups = Groups(token), Privileges = privileges.ToArray() };
    }
    // Read-only evidence for tracked lifecycle-created processes only. A short-lived
    // process may exit first; that is missing evidence, never a fabricated snapshot.
    public static TokenEvidence InspectProcessToken(int processId)
    {
        if (processId <= 0) throw new ArgumentException("Positive tracked process ID required");
        IntPtr process = OpenProcess(0x1000, false, (uint)processId); // QUERY_LIMITED_INFORMATION
        Win32(process != IntPtr.Zero, "OpenProcess for read-only token evidence");
        IntPtr token = IntPtr.Zero;
        try
        {
            Win32(OpenProcessToken(process, TOKEN_QUERY, out token), "OpenProcessToken for read-only evidence");
            return Snapshot(token);
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
    static bool IsPrivilegedGroup(string sid)
    {
        // Enumerated built-in operator/admin roles plus local-account-and-admin SID.
        // This is not a complete model of arbitrary domain/custom ACL group grants.
        return sid == "S-1-5-114" || sid == "S-1-5-32-544" || sid == "S-1-5-32-547" ||
            sid == "S-1-5-32-548" || sid == "S-1-5-32-549" || sid == "S-1-5-32-550" ||
            sid == "S-1-5-32-551" || sid == "S-1-5-32-552" || sid == "S-1-5-32-556";
    }
    static void Check(TokenEvidence source, TokenEvidence token)
    {
        if (token.UserSid != source.UserSid || token.IntegritySid != "S-1-16-8192" || token.IsElevated != 0 || token.UIAccess != 0)
            throw new InvalidOperationException("Token gate failed: user SID / medium integrity / non-elevated / no UIAccess");
        bool sawAdministrators = false;
        foreach (GroupEvidence g in token.Groups)
        {
            if (g.Sid == "S-1-5-32-544") sawAdministrators = true;
            if (IsPrivilegedGroup(g.Sid) && ((g.Attributes & GROUP_ENABLED) != 0 || (g.Attributes & GROUP_DENY_ONLY) == 0))
                throw new InvalidOperationException("Token gate failed: privileged group is not deny-only: " + g.Sid);
        }
        if (!sawAdministrators) throw new InvalidOperationException("Expected hosted-admin source group missing; review actual runner identity");
        foreach (PrivilegeEvidence p in token.Privileges)
            if (p.Name != "SeChangeNotifyPrivilege") throw new InvalidOperationException("Token gate failed: retained privilege " + p.Name);
        if (token.HasRestrictions == 0) throw new InvalidOperationException("Token gate failed: token was not reported as filtered");
    }
    static void Medium(IntPtr token)
    {
        SecurityIdentifier sid = new SecurityIdentifier("S-1-16-8192");
        byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        IntPtr p = Marshal.AllocHGlobal(size + bytes.Length);
        try
        {
            IntPtr sidPointer = IntPtr.Add(p, size); Marshal.Copy(bytes, 0, sidPointer, bytes.Length);
            SID_AND_ATTRIBUTES label = new SID_AND_ATTRIBUTES { Sid = sidPointer, Attributes = 0x20 };
            Marshal.StructureToPtr(label, p, false);
            Win32(SetTokenInformation(token, TokenIntegrityLevel, p, size + bytes.Length), "SetTokenInformation medium integrity");
        }
        finally { Marshal.FreeHGlobal(p); }
    }
    static IntPtr EnvironmentBlock(string[] pairs)
    {
        if (pairs == null || pairs.Length == 0) throw new ArgumentException("Explicit non-secret environment is required");
        string[] copy = (string[])pairs.Clone();
        Array.Sort(copy, StringComparer.OrdinalIgnoreCase);
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string pair in copy)
        {
            if (pair == null || pair.IndexOf('\0') >= 0) throw new ArgumentException("Invalid environment entry");
            int eq = pair.IndexOf('=');
            if (eq <= 0 || !names.Add(pair.Substring(0, eq))) throw new ArgumentException("Invalid or duplicate environment name");
        }
        return Marshal.StringToHGlobalUni(string.Join("\0", copy) + "\0\0");
    }
    public static LaunchEvidence Run(string executable, string arguments, string workingDirectory, string[] environment, int timeoutMilliseconds)
    {
        if (!Path.IsPathRooted(executable) || !File.Exists(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Existing absolute .exe path required");
        if (!Path.IsPathRooted(workingDirectory) || !Directory.Exists(workingDirectory) || timeoutMilliseconds <= 0)
            throw new ArgumentException("Existing absolute working directory and positive timeout required");
        if (executable.IndexOf('"') >= 0 || executable.IndexOf('\0') >= 0 || (arguments ?? "").IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid executable or arguments");
        LastEvidence = new LaunchEvidence { Stage = "open-current-primary-token" };
        IntPtr source = IntPtr.Zero, restricted = IntPtr.Zero, childToken = IntPtr.Zero, env = IntPtr.Zero, job = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        List<IntPtr> allocatedSids = new List<IntPtr>();
        bool assigned = false, finished = false;
        try
        {
            Win32(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_IMPERSONATE | TOKEN_ADJUST_DEFAULT, out source), LastEvidence.Stage);
            LastEvidence.Source = Snapshot(source);
            List<SID_AND_ATTRIBUTES> disabled = new List<SID_AND_ATTRIBUTES>();
            foreach (GroupEvidence g in LastEvidence.Source.Groups) if (IsPrivilegedGroup(g.Sid))
            {
                SecurityIdentifier sid = new SecurityIdentifier(g.Sid); byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
                IntPtr ptr = Marshal.AllocHGlobal(bytes.Length); allocatedSids.Add(ptr); Marshal.Copy(bytes, 0, ptr, bytes.Length);
                disabled.Add(new SID_AND_ATTRIBUTES { Sid = ptr, Attributes = 0 });
            }
            List<LUID_AND_ATTRIBUTES> deleted = new List<LUID_AND_ATTRIBUTES>();
            foreach (LUID_AND_ATTRIBUTES privilege in PrivilegeEntries(source))
                if (PrivilegeName(privilege.Luid) != "SeChangeNotifyPrivilege") deleted.Add(privilege);
            LastEvidence.Stage = "create-restricted-token";
            Win32(CreateRestrictedToken(source, LUA_TOKEN, (uint)disabled.Count, disabled.ToArray(), (uint)deleted.Count,
                deleted.ToArray(), 0, IntPtr.Zero, out restricted), LastEvidence.Stage);
            LastEvidence.Stage = "lower-private-token-integrity"; Medium(restricted);
            LastEvidence.Prepared = Snapshot(restricted); Check(LastEvidence.Source, LastEvidence.Prepared);
            env = EnvironmentBlock(environment);
            job = CreateJobObject(IntPtr.Zero, null); Win32(job != IntPtr.Zero, "CreateJobObject");
            EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Win32(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject kill-on-close");
            STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            // NULL desktop inherits caller's desktop. Trusted validation only, not a sandbox.
            LastEvidence.Stage = "create-child-suspended";
            StringBuilder command = new StringBuilder("\"" + executable + "\" " + (arguments ?? ""));
            Win32(CreateProcessAsUserW(restricted, executable, command, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, env, workingDirectory, ref startup, out pi), LastEvidence.Stage);
            LastEvidence.ChildProcessId = pi.processId;
            Win32(AssignProcessToJobObject(job, pi.process), "AssignProcessToJobObject"); assigned = true;
            LastEvidence.Stage = "verify-actual-suspended-child-token";
            Win32(OpenProcessToken(pi.process, TOKEN_QUERY, out childToken), "OpenProcessToken child");
            LastEvidence.Child = Snapshot(childToken); Check(LastEvidence.Source, LastEvidence.Child);
            LastEvidence.TokenGatePassed = true;
            LastEvidence.Stage = "run-verified-child";
            if (ResumeThread(pi.thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
            Stopwatch timer = Stopwatch.StartNew();
            uint wait = WaitForSingleObject(pi.process, (uint)timeoutMilliseconds);
            if (wait == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
            if (wait == WAIT_TIMEOUT) throw new TimeoutException("Initial child timed out");
            if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("Unexpected process wait result");
            uint exit; Win32(GetExitCodeProcess(pi.process, out exit), "GetExitCodeProcess"); LastEvidence.ExitCode = exit;
            LastEvidence.Stage = "wait-process-tree";
            while (true)
            {
                JOB_ACCOUNTING accounting;
                Win32(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOB_ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
                if (accounting.activeProcesses == 0) break;
                if (timer.ElapsedMilliseconds >= timeoutMilliseconds) throw new TimeoutException("Installer descendant process tree timed out");
                Thread.Sleep(100);
            }
            finished = true; LastEvidence.ProcessTreeFinished = true; LastEvidence.Stage = "finished";
            return LastEvidence;
        }
        finally
        {
            // An unassigned suspended child cannot be cleaned by closing the job.
            if (pi.process != IntPtr.Zero && !assigned && !finished) TerminateProcess(pi.process, 0xdead);
            if (job != IntPtr.Zero) CloseHandle(job); // Kills this job's remaining descendants on any failure.
            if (pi.thread != IntPtr.Zero) CloseHandle(pi.thread);
            if (pi.process != IntPtr.Zero) CloseHandle(pi.process);
            if (childToken != IntPtr.Zero) CloseHandle(childToken);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (source != IntPtr.Zero) CloseHandle(source);
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            foreach (IntPtr sid in allocatedSids) Marshal.FreeHGlobal(sid);
        }
    }
}
