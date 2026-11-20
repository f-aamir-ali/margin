param([Parameter(Mandatory)][int] $AppProcessId)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CaptionHit {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32")]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wp,
        IntPtr lp, uint flags, uint ms, out IntPtr result);

    public static long HitTest(IntPtr window, int x, int y) {
        IntPtr result;
        long coords = (ushort)x | ((long)(ushort)y << 16);
        if (SendMessageTimeout(window, 0x84, IntPtr.Zero, new IntPtr(coords), 2, 1000, out result) == IntPtr.Zero)
            throw new Exception("The window didn't answer WM_NCHITTEST");
        return result.ToInt64();
    }
}
'@

$window = (Get-Process -Id $AppProcessId).MainWindowHandle
$resize = [CaptionHit]::FindWindowEx($window, [IntPtr]::Zero, 'TAURI_DRAG_RESIZE_BORDERS', 'TAURI_DRAG_RESIZE_WINDOW')
$bounds = New-Object CaptionHit+Rect
if ($resize -eq [IntPtr]::Zero -or -not [CaptionHit]::GetWindowRect($resize, [ref]$bounds)) {
    throw "Couldn't find the test window's native resize strip."
}

[pscustomobject]@{
    close = [CaptionHit]::HitTest($resize, $bounds.Right - 2, $bounds.Top + 1)
    resize = [CaptionHit]::HitTest($resize, [int](($bounds.Left + $bounds.Right) / 2), $bounds.Top + 1)
} | ConvertTo-Json -Compress
