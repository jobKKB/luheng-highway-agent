using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

// Read-only Restart Manager enumeration proves the restarted backend opened the original database.
// No process environment, authentication file, shutdown, or restart operation is read or invoked.
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
public static class OnlineUpdateFileOwners
{
    [StructLayout(LayoutKind.Sequential)] struct UniqueProcess
    {
        public uint ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME Started;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Application;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public uint Type, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint session, uint files, string[] names,
        uint applications, IntPtr processes, uint services, IntPtr serviceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint session, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] information, ref uint reasons);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
    static void Check(int result) { if (result != 0) throw new Win32Exception(result); }

    public static int[] ForFile(string file)
    {
        uint session;
        Check(RmStartSession(out session, 0, new StringBuilder(33)));
        try
        {
            Check(RmRegisterResources(session, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero));
            uint count = 0, needed, reasons = 0;
            int result = RmGetList(session, out needed, ref count, null, ref reasons);
            for (int attempt = 0; result == 234 && attempt < 3; attempt++)
            {
                count = needed;
                var information = new ProcessInfo[count];
                result = RmGetList(session, out needed, ref count, information, ref reasons);
                if (result == 0) return information.Take((int)count).Select(p => (int)p.Process.ProcessId).ToArray();
            }
            Check(result);
            return Array.Empty<int>();
        }
        finally { RmEndSession(session); }
    }
}
