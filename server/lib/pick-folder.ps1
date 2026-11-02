# Windows folder picker for the kit: the modern Explorer-style "Select Folder" dialog (resizable, address bar,
# quick access, search), not the old tree-view FolderBrowserDialog. Prints the chosen path on stdout, nothing when cancelled.
# Inputs (environment): KIT_TITLE, KIT_START (folder to open in). KIT_SELFTEST=1 only checks that the dialog code compiles.
# If the modern dialog cannot be created for any reason, the old dialog is used so the button never fails.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$source = @'
using System;
using System.Runtime.InteropServices;

public static class KitFolderDialog
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    class FileOpenDialogCoClass { }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
    const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    /// <summary>Shows the dialog. Returns the folder, or null when the user cancelled.</summary>
    public static string Pick(IntPtr owner, string title, string start)
    {
        IFileDialog dlg = (IFileDialog)new FileOpenDialogCoClass();
        uint options; dlg.GetOptions(out options);
        dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
        if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start))
        {
            Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
            IShellItem item;
            SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out item);
            dlg.SetFolder(item);
        }
        int hr = dlg.Show(owner);
        if (hr == ERROR_CANCELLED) return null;
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        IShellItem result; dlg.GetResult(out result);
        string path; result.GetDisplayName(0x80058000 /* SIGDN_FILESYSPATH */, out path);
        return path;
    }
}
'@

if ($env:KIT_SELFTEST -eq '1') { Add-Type -TypeDefinition $source -ErrorAction Stop; Write-Output 'compiled'; return }

# A transparent, always-on-top owner window makes sure the dialog opens in front of the kit's browser window.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'
$owner.Show()

$picked = $null
try {
    Add-Type -TypeDefinition $source -ErrorAction Stop   # can fail too (e.g. Constrained Language Mode): then the old dialog
    $picked = [KitFolderDialog]::Pick($owner.Handle, $env:KIT_TITLE, $env:KIT_START)
} catch {
    # fall back to the old dialog rather than leave the button dead
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = $env:KIT_TITLE; $f.ShowNewFolderButton = $true
    if ($env:KIT_START -and (Test-Path -LiteralPath $env:KIT_START)) { $f.SelectedPath = $env:KIT_START }
    if ($f.ShowDialog($owner) -eq 'OK') { $picked = $f.SelectedPath }
}
$owner.Close()
if ($picked) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $picked }
