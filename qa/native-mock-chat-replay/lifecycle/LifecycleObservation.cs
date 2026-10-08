// Proposal only: bounded read-only diagnostics; does not launch, signal or terminate processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class LifecycleObservation
{
    public sealed class TreeSnapshot
    {
        public string Root; public bool Exists, Complete; public long Files, Bytes, Directories, ReparsePoints, Errors, ElapsedMilliseconds;
        public string StopReason;
    }
    public static TreeSnapshot ReadTree(string root, int budgetMilliseconds)
    {
        TreeSnapshot r = new TreeSnapshot { Root = root, Exists = Directory.Exists(root), Complete = false };
        Stopwatch timer = Stopwatch.StartNew();
        if (!r.Exists) { r.Complete = true; r.StopReason = "absent"; return r; }
        Stack<DirectoryInfo> pending = new Stack<DirectoryInfo>(); pending.Push(new DirectoryInfo(root));
        while (pending.Count != 0)
        {
            if (timer.ElapsedMilliseconds >= budgetMilliseconds) { r.StopReason = "observation-budget"; break; }
            DirectoryInfo dir = pending.Pop();
            try
            {
                if ((dir.Attributes & FileAttributes.ReparsePoint) != 0) { r.ReparsePoints++; continue; }
                r.Directories++;
                foreach (FileSystemInfo item in dir.EnumerateFileSystemInfos())
                {
                    if (timer.ElapsedMilliseconds >= budgetMilliseconds) { r.StopReason = "observation-budget"; break; }
                    try
                    {
                        if ((item.Attributes & FileAttributes.ReparsePoint) != 0) { r.ReparsePoints++; continue; }
                        DirectoryInfo child = item as DirectoryInfo;
                        if (child != null) pending.Push(child);
                        else { r.Files++; r.Bytes += ((FileInfo)item).Length; }
                    }
                    catch (IOException) { r.Errors++; }
                    catch (UnauthorizedAccessException) { r.Errors++; }
                }
                if (r.StopReason != null) break;
            }
            catch (IOException) { r.Errors++; }
            catch (UnauthorizedAccessException) { r.Errors++; }
        }
        r.Complete = r.StopReason == null && r.Errors == 0 && r.ReparsePoints == 0;
        if (r.StopReason == null) r.StopReason = r.Complete ? "enumerated-nonatomic" : "partial-errors-or-reparse-points";
        r.ElapsedMilliseconds = timer.ElapsedMilliseconds; return r;
    }
    public sealed class WindowSnapshot
    {
        public long Handle; public int ProcessId; public string Title, ClassName; public bool Visible;
        public int Left, Top, Right, Bottom;
    }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumCallback(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    public static WindowSnapshot[] ReadWindows(int[] processIds)
    {
        HashSet<int> ids = new HashSet<int>(processIds); List<WindowSnapshot> result = new List<WindowSnapshot>();
        EnumCallback callback = delegate(IntPtr hwnd, IntPtr ignored)
        {
            uint pid; GetWindowThreadProcessId(hwnd, out pid); if (!ids.Contains((int)pid)) return true;
            StringBuilder title = new StringBuilder(2048), type = new StringBuilder(256); RECT rect;
            GetWindowText(hwnd, title, title.Capacity); GetClassName(hwnd, type, type.Capacity); GetWindowRect(hwnd, out rect);
            result.Add(new WindowSnapshot { Handle=hwnd.ToInt64(), ProcessId=(int)pid, Title=title.ToString(), ClassName=type.ToString(),
                Visible=IsWindowVisible(hwnd), Left=rect.Left, Top=rect.Top, Right=rect.Right, Bottom=rect.Bottom }); return true;
        };
        if (!EnumWindows(callback, IntPtr.Zero)) throw new InvalidOperationException("Could not enumerate native windows");
        GC.KeepAlive(callback); return result.ToArray();
    }
}
