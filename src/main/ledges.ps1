# ledges.ps1 - the window list behind src/main/ledges.mjs, one JSON line per change.
#
# READ-ONLY. This script looks at other programs' windows and never touches
# them: nothing here moves, sizes, focuses, shows, hides or sends input to any
# window. Every Win32 call below is a query:
#   EnumWindows              - walk the top-level windows, top of the z-order first
#   IsWindowVisible          - skip windows that are not shown at all
#   IsIconic                 - skip minimized windows (their rect is parked off-screen)
#   GetWindowThreadProcessId - find the owning pid, to drop the pet's own window
#   GetWindowLong(EXSTYLE)   - read WS_EX_TOOLWINDOW / WS_EX_TRANSPARENT for the caller
#   GetClassName             - report the class, so the caller can drop the shell
#   DwmGetWindowAttribute 14 - DWMWA_CLOAKED: skip windows on other virtual desktops
#                              and suspended store apps, which are "visible" but not shown
#   DwmGetWindowAttribute 9  - DWMWA_EXTENDED_FRAME_BOUNDS: the edge you can see, in
#                              physical px. GetWindowRect includes the invisible ~7px
#                              resize border on the left, right and bottom: too wide.
# The only other two calls are on this process's own stdout, not on any window:
#   GetStdHandle / WriteFile - write a line and learn when the reader has gone (see Emit)
#
# Output: {"v":1,"windows":[{"hwnd":..,"cls":"..","tool":..,"through":..,"l":..,"t":..,"r":..,"b":..},..]}
# written only when it differs from the last line written (the first poll always
# writes), so with nothing moving on screen this process writes nothing at all.
#
# Windows PowerShell 5.1 (powershell.exe), never pwsh. This file must stay pure
# ASCII: 5.1 reads a BOM-less script in the ANSI code page. The C# below is C# 5,
# which is what 5.1's Add-Type compiles.

param(
  # Optional. When given: windows owned by this pid (the pet's own) are left out,
  # and the script exits by itself once that process is gone.
  [int]$ParentPid = 0,
  [int]$IntervalMs = 250
)

$ErrorActionPreference = 'Stop'
if ($IntervalMs -lt 250) { $IntervalMs = 250 } # at most 4 Hz

Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace GanyuPerch {
  public static class Ledges {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    // Our own stdout only - see Emit.
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

    const int STD_OUTPUT_HANDLE = -11;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;

    static string Num(long value) {
      return value.ToString(CultureInfo.InvariantCulture);
    }

    // Everything outside printable ASCII is escaped, so the line is pure ASCII
    // and the console code page this process happens to have cannot mangle it.
    static void AppendJsonString(StringBuilder sb, string s) {
      sb.Append('"');
      foreach (char c in s) {
        if (c == '"') sb.Append("\\\"");
        else if (c == '\\') sb.Append("\\\\");
        else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        else sb.Append(c);
      }
      sb.Append('"');
    }

    // One poll: every window that is actually on screen, in z-order, as one line.
    public static string Snapshot(uint skipPid) {
      StringBuilder sb = new StringBuilder("{\"v\":1,\"windows\":[");
      StringBuilder cls = new StringBuilder(257);
      bool first = true;
      EnumWindowsProc visit = delegate(IntPtr h, IntPtr unused) {
        if (!IsWindowVisible(h) || IsIconic(h)) return true;
        if (skipPid != 0) {
          uint pid;
          GetWindowThreadProcessId(h, out pid);
          if (pid == skipPid) return true;
        }
        int cloaked;
        if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) != 0 || cloaked != 0) return true;
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0) return true;
        if (r.Right <= r.Left || r.Bottom <= r.Top) return true;

        int ex = GetWindowLong(h, GWL_EXSTYLE);
        cls.Length = 0;
        GetClassName(h, cls, cls.Capacity);

        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"hwnd\":").Append(Num(h.ToInt64()));
        sb.Append(",\"cls\":");
        AppendJsonString(sb, cls.ToString());
        sb.Append(",\"tool\":").Append((ex & WS_EX_TOOLWINDOW) != 0 ? "true" : "false");
        sb.Append(",\"through\":").Append((ex & WS_EX_TRANSPARENT) != 0 ? "true" : "false");
        sb.Append(",\"l\":").Append(Num(r.Left));
        sb.Append(",\"t\":").Append(Num(r.Top));
        sb.Append(",\"r\":").Append(Num(r.Right));
        sb.Append(",\"b\":").Append(Num(r.Bottom));
        sb.Append('}');
        return true;
      };
      EnumWindows(visit, IntPtr.Zero);
      GC.KeepAlive(visit); // native code holds the only other reference during the walk
      sb.Append("]}");
      return sb.ToString();
    }

    // One line to stdout; false once nobody is reading it. Not [Console]::Out:
    // the .NET Framework console stream treats a closed pipe (ERROR_NO_DATA /
    // ERROR_BROKEN_PIPE) as success, so a script writing through it never learns
    // its reader is gone. WriteFile reports it. A blocking pipe writes the whole
    // buffer or fails, so a short write is treated as a failure too.
    public static bool Emit(string line) {
      IntPtr handle = GetStdHandle(STD_OUTPUT_HANDLE);
      if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return false;
      byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
      int written;
      return WriteFile(handle, bytes, bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
    }
  }
}
'@

# A handle on the parent, not just its pid: a pid can be reused by an unrelated
# process after the parent exits, a held handle cannot be.
$parent = $null
if ($ParentPid -gt 0) {
  try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { exit 0 }
}

$last = $null
while ($true) {
  if ($null -ne $parent -and $parent.HasExited) { exit 0 }
  $line = [GanyuPerch.Ledges]::Snapshot([uint32]$ParentPid)
  if ($line -cne $last) {
    if (-not [GanyuPerch.Ledges]::Emit($line)) { exit 0 } # stdout is gone: nobody is listening
    $last = $line
  }
  Start-Sleep -Milliseconds $IntervalMs
}
