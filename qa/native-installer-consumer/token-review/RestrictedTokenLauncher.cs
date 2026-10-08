// Draft, reviewed against Microsoft Win32 contracts. NOT compiled or run on Windows.
// Process-local filtering only. This is not a standard-account or sandbox proof.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
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
    const int TokenUser = 1, TokenGroups = 2, TokenPrivileges = 3, TokenOwner = 4, TokenDefaultDacl = 6;
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
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
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
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES
    { public uint length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CreatePipe")] static extern bool CreatePipeWithAttributes(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] data, uint size, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] data, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    static extern bool QueryProcessIds(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESS_ENTRY
    {
        public uint size, usage, processId; public UIntPtr defaultHeap;
        public uint moduleId, threads, parentId; public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref PROCESS_ENTRY entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref PROCESS_ENTRY entry);
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    public class GroupEvidence { public string Sid; public uint Attributes; }
    public class PrivilegeEvidence { public string Name; public uint Attributes; }
    public class TokenEvidence
    {
        public string UserSid, IntegritySid;
        public string OwnerSid, DefaultDaclSddl;
        public bool DefaultDaclIsNull;
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
        public ProcessEvidence[] RemainingBeforeCleanup;
        public bool ForcedCleanup, CleanupTreeFinished;
        public string CleanupError;
    }
    public class ProcessEvidence { public int Pid, ParentPid; public string Path, QueryError; public string[] Windows; }
    // Single-invocation helper: lets the PowerShell consumer preserve evidence on failure.
    public static LaunchEvidence LastEvidence;

    public class PipeEvidence
    {
        public bool Created, RoundTrip;
        public bool DuplicateReadCreated, DuplicateWriteCreated;
        public int Win32Error;
        public int DuplicateReadError, DuplicateWriteError;
        public int? SecurityQueryWin32Error;
        public string SecuritySddl, Error;
    }
    public class ObjectAccessEvidence
    {
        public TokenEvidence Token;
        public string SelfProcessSddl, SelfProcessSecurityError;
        public int SelfProcessAllAccessReopenError;
        public PipeEvidence PipeDefaultNullAttributes, PipeDefaultInheritable, PipeExplicitUserSystem;
    }
    static string SecuritySddl(IntPtr handle, int objectType)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, objectType, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, "GetSecurityInfo owner/DACL (Win32 " + error + "): " + new Win32Exception((int)error).Message);
        IntPtr text = IntPtr.Zero;
        try
        {
            uint length;
            Win32(ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 5, out text, out length), "Convert object owner/DACL to SDDL");
            return Marshal.PtrToStringUni(text);
        }
        finally { if (text != IntPtr.Zero) LocalFree(text); if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    static PipeEvidence ProbePipe(bool useAttributes, string explicitSddl)
    {
        var evidence = new PipeEvidence(); IntPtr descriptor = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero;
        IntPtr duplicateRead = IntPtr.Zero, duplicateWrite = IntPtr.Zero;
        bool created = false;
        try
        {
            if (explicitSddl != null)
            {
                uint size;
                Win32(ConvertStringSecurityDescriptorToSecurityDescriptor(explicitSddl, 1, out descriptor, out size), "Convert isolated pipe descriptor");
            }
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { length = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), descriptor = descriptor, inherit = true };
            created = useAttributes ? CreatePipeWithAttributes(out read, out write, ref attributes, 0) : CreatePipe(out read, out write, IntPtr.Zero, 0);
            evidence.Win32Error = created ? 0 : Marshal.GetLastWin32Error(); evidence.Created = created;
            if (!created) return evidence;
            // .NET makes the parent end non-inheritable with DuplicateHandle;
            // record both directions so CreatePipe and duplication failures differ.
            evidence.DuplicateReadCreated = DuplicateHandle(GetCurrentProcess(), read, GetCurrentProcess(), out duplicateRead, 0, false, 2);
            evidence.DuplicateReadError = evidence.DuplicateReadCreated ? 0 : Marshal.GetLastWin32Error();
            evidence.DuplicateWriteCreated = DuplicateHandle(GetCurrentProcess(), write, GetCurrentProcess(), out duplicateWrite, 0, false, 2);
            evidence.DuplicateWriteError = evidence.DuplicateWriteCreated ? 0 : Marshal.GetLastWin32Error();
            uint written, received; byte[] sent = { 0x5a }, data = new byte[1];
            Win32(WriteFile(write, sent, 1, out written, IntPtr.Zero), "Write isolated anonymous pipe");
            if (written != 1) throw new InvalidOperationException("Isolated pipe short write");
            Win32(ReadFile(read, data, 1, out received, IntPtr.Zero), "Read isolated anonymous pipe");
            evidence.RoundTrip = received == 1 && data[0] == sent[0];
            try { evidence.SecuritySddl = SecuritySddl(read, 1); }
            catch (Win32Exception error) { evidence.SecurityQueryWin32Error = error.NativeErrorCode; evidence.Error = error.Message; }
        }
        catch (Exception error) { evidence.Error = error.Message; }
        finally
        {
            // Failed CreatePipe output handles are indeterminate and must not be closed.
            if (created) { CloseHandle(read); CloseHandle(write); }
            if (evidence.DuplicateReadCreated) CloseHandle(duplicateRead);
            if (evidence.DuplicateWriteCreated) CloseHandle(duplicateWrite);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
        return evidence;
    }
    public static ObjectAccessEvidence ProbeCurrentObjectAccess()
    {
        // Read-only token/process diagnostics plus disposable anonymous objects.
        // The comparison descriptor never changes a token, account or existing ACL.
        var evidence = new ObjectAccessEvidence { Token = InspectProcessToken((int)GetCurrentProcessId()) };
        try { evidence.SelfProcessSddl = SecuritySddl(GetCurrentProcess(), 6); }
        catch (Exception error) { evidence.SelfProcessSecurityError = error.Message; }
        IntPtr reopened = OpenProcess(0x001fffff, false, GetCurrentProcessId());
        evidence.SelfProcessAllAccessReopenError = reopened == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        if (reopened != IntPtr.Zero) CloseHandle(reopened);
        evidence.PipeDefaultNullAttributes = ProbePipe(false, null);
        evidence.PipeDefaultInheritable = ProbePipe(true, null);
        evidence.PipeExplicitUserSystem = ProbePipe(true, "D:(A;;GA;;;SY)(A;;GA;;;" + evidence.Token.UserSid + ")");
        return evidence;
    }

    static int[] OwnedIds(IntPtr job)
    {
        for (int capacity = 64; capacity <= 65536; capacity *= 2)
        {
            int size = 8 + capacity * IntPtr.Size; IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryProcessIds(job, 3, buffer, (uint)size, IntPtr.Zero))
                { if (Marshal.GetLastWin32Error() == 234) continue; Win32(false, "Read outer job IDs"); }
                int count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > capacity) throw new InvalidOperationException("Invalid outer job PID count");
                int[] ids = new int[count];
                for (int i = 0; i < count; i++) ids[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                return ids;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Outer job PID inventory exceeded bound");
    }
    static ProcessEvidence[] DescribeOwned(IntPtr job)
    {
        var rows = new Dictionary<int, ProcessEvidence>();
        foreach (int id in OwnedIds(job)) rows[id] = new ProcessEvidence { Pid = id };
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot != new IntPtr(-1))
        {
            try
            {
                PROCESS_ENTRY entry = new PROCESS_ENTRY(); entry.size = (uint)Marshal.SizeOf(typeof(PROCESS_ENTRY));
                if (Process32First(snapshot, ref entry)) do
                { if (rows.ContainsKey((int)entry.processId)) rows[(int)entry.processId].ParentPid = (int)entry.parentId; }
                while (Process32Next(snapshot, ref entry));
            }
            finally { CloseHandle(snapshot); }
        }
        foreach (ProcessEvidence row in rows.Values)
        {
            // Diagnostics use limited query rights; no ALL_ACCESS reopen or PID-based termination.
            IntPtr process = OpenProcess(0x1000, false, (uint)row.Pid);
            if (process == IntPtr.Zero) row.QueryError = "OpenProcess limited query: " + Marshal.GetLastWin32Error();
            else try
            {
                uint size = 32768; var path = new StringBuilder((int)size);
                if (QueryFullProcessImageName(process, 0, path, ref size)) row.Path = path.ToString();
                else row.QueryError = "QueryFullProcessImageName: " + Marshal.GetLastWin32Error();
            }
            finally { CloseHandle(process); }
            var windows = new List<string>();
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                uint pid; GetWindowThreadProcessId(window, out pid);
                if (pid == row.Pid && windows.Count < 20)
                { var title = new StringBuilder(512); GetWindowText(window, title, title.Capacity); windows.Add(title.ToString()); }
                return true;
            }, IntPtr.Zero);
            row.Windows = windows.ToArray();
        }
        return new List<ProcessEvidence>(rows.Values).ToArray();
    }
    static void StopFailedJob(IntPtr job)
    {
        LastEvidence.ForcedCleanup = true;
        try { LastEvidence.RemainingBeforeCleanup = DescribeOwned(job); }
        catch (Exception error) { LastEvidence.CleanupError = "Snapshot: " + error.Message; }
        try
        {
            Win32(TerminateJobObject(job, 0xdead), "Terminate failed outer job");
            var timer = Stopwatch.StartNew();
            do
            {
                JOB_ACCOUNTING info;
                Win32(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(JOB_ACCOUNTING)), IntPtr.Zero), "Observe failed outer job cleanup");
                if (info.activeProcesses == 0) { LastEvidence.CleanupTreeFinished = true; break; }
                Thread.Sleep(50);
            } while (timer.ElapsedMilliseconds < 5000);
            if (!LastEvidence.CleanupTreeFinished) throw new TimeoutException("Failed outer job did not empty within cleanup bound");
        }
        catch (Exception error) { LastEvidence.CleanupError = (LastEvidence.CleanupError ?? "") + "; " + error.Message; }
    }

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
    {
        // These TOKEN_INFORMATION_CLASS values return a fixed DWORD, not a
        // variable-size object. Supply its documented buffer directly.
        IntPtr p = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            int needed;
            bool ok = GetTokenInformation(token, kind, p, sizeof(uint), out needed);
            int error = Marshal.GetLastWin32Error();
            if (!ok) throw new Win32Exception(error, "GetTokenInformation DWORD " + kind + " (Win32 " + error + ")");
            // TokenHasRestrictions is returned as a BOOLEAN byte by this
            // native API, unlike the DWORD-valued elevation/UIAccess classes.
            if (kind == TokenHasRestrictions && needed == 1) return Marshal.ReadByte(p);
            if (needed != sizeof(uint)) throw new InvalidOperationException("Unexpected token DWORD size " + kind + ": " + needed);
            return unchecked((uint)Marshal.ReadInt32(p));
        }
        finally { Marshal.FreeHGlobal(p); }
    }
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
        var evidence = new TokenEvidence { UserSid = TokenSid(token, TokenUser), IntegritySid = TokenSid(token, TokenIntegrityLevel),
            OwnerSid = TokenSid(token, TokenOwner),
            IsElevated = Dword(token, TokenElevation), ElevationType = Dword(token, TokenElevationType),
            HasRestrictions = Dword(token, TokenHasRestrictions), UIAccess = Dword(token, TokenUIAccess),
            Groups = Groups(token), Privileges = privileges.ToArray() };
        IntPtr buffer = Read(token, TokenDefaultDacl);
        try
        {
            IntPtr acl = Marshal.ReadIntPtr(buffer); evidence.DefaultDaclIsNull = acl == IntPtr.Zero;
            if (acl != IntPtr.Zero)
            {
                int size = (ushort)Marshal.ReadInt16(acl, 2);
                if (size < 8) throw new InvalidOperationException("Invalid token default ACL size");
                byte[] data = new byte[size]; Marshal.Copy(acl, data, 0, size);
                var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent,
                    new SecurityIdentifier(evidence.OwnerSid), null, null, new RawAcl(data, 0));
                evidence.DefaultDaclSddl = descriptor.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        return evidence;
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
            // A failed probe can never qualify. Its leftover descendants must not
            // consume the successful-probe wait budget before owned-job cleanup.
            if (exit != 0)
            {
                LastEvidence.Stage = "probe-exit-nonzero";
                throw new InvalidOperationException("Restricted probe exited with code " + exit);
            }
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
            if (assigned && !finished) StopFailedJob(job);
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
