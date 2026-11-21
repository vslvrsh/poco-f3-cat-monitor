using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PurrCamLauncher
{
    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();

        internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        internal static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("dwmapi.dll")]
        internal static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll")]
        internal static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll")]
        internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll")]
        internal static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        internal const int JobObjectExtendedLimitInformation = 9;
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        internal static IntPtr CreateKillOnCloseJob()
        {
            IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero) return IntPtr.Zero;

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ptr, (uint)length);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            return hJob;
        }

        internal static void HideAuxiliaryTopLevelWindows(IntPtr mainFormHwnd)
        {
            uint currentPid = (uint)Process.GetCurrentProcess().Id;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (hWnd == mainFormHwnd) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == currentPid)
                {
                    StringBuilder sb = new StringBuilder(128);
                    GetClassName(hWnd, sb, sb.Capacity);
                    string cls = sb.ToString();
                    if (cls.StartsWith("UAC", StringComparison.OrdinalIgnoreCase))
                    {
                        ShowWindow(hWnd, 0);
                    }
                }
                return true;
            }, IntPtr.Zero);
        }
    }

    internal static class M3Geometry
    {
        public static GraphicsPath CreateRoundedPath(RectangleF rect, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = radius * 2f;
            if (d > rect.Width) d = rect.Width;
            if (d > rect.Height) d = rect.Height;
            if (d <= 1f)
            {
                path.AddRectangle(rect);
                return path;
            }
            path.AddArc(rect.X, rect.Y, d, d, 180f, 90f);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270f, 90f);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0f, 90f);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90f, 90f);
            path.CloseFigure();
            return path;
        }

        public static Color BlendColor(Color baseCol, Color overlay, float amount)
        {
            int r = (int)Math.Max(0, Math.Min(255, baseCol.R + (overlay.R - baseCol.R) * amount));
            int g = (int)Math.Max(0, Math.Min(255, baseCol.G + (overlay.G - baseCol.G) * amount));
            int b = (int)Math.Max(0, Math.Min(255, baseCol.B + (overlay.B - baseCol.B) * amount));
            return Color.FromArgb(r, g, b);
        }
    }

    /// <summary>
    /// Material 3 Expressive tonal surface card with 28px anti-aliased rounded corners and zero 1px border.
    /// </summary>
    internal class M3Card : Panel
    {
        public float CornerRadius = 28f;
        public Color SurfaceColor = Color.FromArgb(33, 31, 38); // #211F26 surfaceContainer
        public Color ParentSurfaceColor = Color.FromArgb(20, 18, 24); // #141218 surface

        public M3Card()
        {
            this.DoubleBuffered = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true
            );
            this.BackColor = SurfaceColor;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            using (SolidBrush parentBrush = new SolidBrush(ParentSurfaceColor))
            {
                e.Graphics.FillRectangle(parentBrush, this.ClientRectangle);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            RectangleF rect = new RectangleF(0.5f, 0.5f, this.Width - 1f, this.Height - 1f);
            using (GraphicsPath path = M3Geometry.CreateRoundedPath(rect, CornerRadius))
            using (SolidBrush brush = new SolidBrush(SurfaceColor))
            {
                e.Graphics.FillPath(brush, path);
            }
            base.OnPaint(e);
        }
    }

    /// <summary>
    /// Material 3 Expressive stadium badge / tonal status pill with optional live dot.
    /// </summary>
    internal class M3Badge : Control
    {
        public Color ContainerColor = Color.FromArgb(30, 58, 47);
        public Color ContentColor = Color.FromArgb(125, 211, 168);
        public Color ParentSurfaceColor = Color.FromArgb(20, 18, 24);
        public bool ShowDot = true;
        public float CornerRadius = -1f; // -1 = full stadium capsule

        public M3Badge()
        {
            this.DoubleBuffered = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true
            );
            this.Font = new Font("Segoe UI Semibold", 9.2f, FontStyle.Bold);
            this.Size = new Size(190, 36);
        }

        public void SetTone(Color container, Color content, bool showDot)
        {
            this.ContainerColor = container;
            this.ContentColor = content;
            this.ShowDot = showDot;
            this.Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (SolidBrush bg = new SolidBrush(ParentSurfaceColor))
            {
                g.FillRectangle(bg, this.ClientRectangle);
            }

            float r = CornerRadius > 0f ? CornerRadius : (this.Height - 1f) / 2f;
            RectangleF rect = new RectangleF(0.5f, 0.5f, this.Width - 1f, this.Height - 1f);
            using (GraphicsPath path = M3Geometry.CreateRoundedPath(rect, r))
            using (SolidBrush fill = new SolidBrush(ContainerColor))
            {
                g.FillPath(fill, path);
            }

            SizeF textSize = g.MeasureString(this.Text, this.Font);
            float dotDiameter = ShowDot ? 8f : 0f;
            float gap = ShowDot ? 7f : 0f;
            float totalWidth = dotDiameter + gap + textSize.Width;
            float startX = (this.Width - totalWidth) / 2f;

            if (ShowDot)
            {
                float dotY = (this.Height - dotDiameter) / 2f;
                using (SolidBrush dotBrush = new SolidBrush(ContentColor))
                {
                    g.FillEllipse(dotBrush, new RectangleF(startX, dotY, dotDiameter, dotDiameter));
                }
            }

            float textX = startX + dotDiameter + gap;
            float textY = (this.Height - textSize.Height) / 2f;
            using (SolidBrush textBrush = new SolidBrush(ContentColor))
            {
                g.DrawString(this.Text, this.Font, textBrush, new PointF(textX, textY));
            }
        }
    }

    /// <summary>
    /// Material 3 Expressive shape-morphing button:
    /// Full stadium capsule when idle (or 15px squircle when active/hovered/morphed), zero WinForms borders.
    /// </summary>
    internal class M3PillButton : Control
    {
        public Color FillColor = Color.FromArgb(74, 68, 88);         // #4A4458 secondaryContainer
        public Color TextColor = Color.FromArgb(232, 222, 248);      // #E8DEF8 onSecondaryContainer
        public Color ParentSurfaceColor = Color.FromArgb(33, 31, 38); // #211F26 surfaceContainer
        public bool IsSquircleActive = false;

        private bool isHovered = false;
        private bool isPressed = false;
        private float currentRadius = 20f;
        private readonly System.Windows.Forms.Timer morphTimer;

        public M3PillButton()
        {
            this.DoubleBuffered = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw |
                ControlStyles.StandardClick,
                true
            );
            this.Cursor = Cursors.Hand;
            this.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);
            this.Size = new Size(160, 40);
            this.currentRadius = 20f;

            this.morphTimer = new System.Windows.Forms.Timer();
            this.morphTimer.Interval = 16;
            this.morphTimer.Tick += OnMorphTick;
        }

        private float GetTargetRadius()
        {
            float pillRadius = Math.Max(8f, (this.Height - 1f) / 2f);
            float squircleRadius = Math.Min(14f, pillRadius);
            if (isPressed) return Math.Min(11f, pillRadius);
            if (IsSquircleActive || isHovered) return squircleRadius;
            return pillRadius;
        }

        private void OnMorphTick(object sender, EventArgs e)
        {
            float target = GetTargetRadius();
            float diff = target - currentRadius;
            if (Math.Abs(diff) < 0.6f)
            {
                currentRadius = target;
                morphTimer.Stop();
            }
            else
            {
                currentRadius += diff * 0.35f;
            }
            this.Invalidate();
        }

        public void SetStyleColors(Color fill, Color text, bool squircleActive)
        {
            this.FillColor = fill;
            this.TextColor = text;
            this.IsSquircleActive = squircleActive;
            this.currentRadius = GetTargetRadius();
            this.Invalidate();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            this.currentRadius = GetTargetRadius();
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            this.isHovered = true;
            this.morphTimer.Start();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            this.isHovered = false;
            this.isPressed = false;
            this.morphTimer.Start();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left)
            {
                this.isPressed = true;
                this.morphTimer.Start();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            this.isPressed = false;
            this.morphTimer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (SolidBrush parentBg = new SolidBrush(ParentSurfaceColor))
            {
                g.FillRectangle(parentBg, this.ClientRectangle);
            }

            Color drawFill = FillColor;
            if (!this.Enabled)
            {
                drawFill = M3Geometry.BlendColor(FillColor, ParentSurfaceColor, 0.55f);
            }
            else if (isPressed)
            {
                drawFill = M3Geometry.BlendColor(FillColor, Color.White, 0.16f);
            }
            else if (isHovered)
            {
                drawFill = M3Geometry.BlendColor(FillColor, Color.White, 0.09f);
            }

            RectangleF rect = new RectangleF(0.5f, 0.5f, this.Width - 1f, this.Height - 1f);
            using (GraphicsPath path = M3Geometry.CreateRoundedPath(rect, currentRadius))
            using (SolidBrush brush = new SolidBrush(drawFill))
            {
                g.FillPath(brush, path);
            }

            StringFormat sf = new StringFormat();
            sf.Alignment = StringAlignment.Center;
            sf.LineAlignment = StringAlignment.Center;
            sf.Trimming = StringTrimming.EllipsisCharacter;
            sf.FormatFlags = StringFormatFlags.NoWrap;

            Color drawText = this.Enabled ? TextColor : M3Geometry.BlendColor(TextColor, ParentSurfaceColor, 0.45f);
            using (SolidBrush textBrush = new SolidBrush(drawText))
            {
                g.DrawString(this.Text, this.Font, textBrush, rect, sf);
            }
        }
    }

    /// <summary>
    /// Material 3 Expressive 52x32 stadium switch with scaling thumb (16px off -> 24px on) and drawn checkmark.
    /// </summary>
    internal class M3SwitchRow : Control
    {
        public bool Checked = false;
        public Color ParentSurfaceColor = Color.FromArgb(33, 31, 38); // #211F26
        public event EventHandler CheckedChanged;

        private bool isHovered = false;

        private static readonly Color TrackOn = Color.FromArgb(208, 188, 255);   // #D0BCFF primary
        private static readonly Color ThumbOn = Color.FromArgb(56, 30, 114);     // #381E72 onPrimary
        private static readonly Color CheckOn = Color.FromArgb(234, 221, 255);   // #EADDFF
        private static readonly Color TrackOff = Color.FromArgb(54, 52, 59);     // #36343B surfaceContainerHighest
        private static readonly Color OutlineOff = Color.FromArgb(147, 143, 153);// #938F99 outline
        private static readonly Color LabelColor = Color.FromArgb(230, 224, 233);// #E6E0E9 onSurface

        public M3SwitchRow()
        {
            this.DoubleBuffered = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw |
                ControlStyles.StandardClick,
                true
            );
            this.Cursor = Cursors.Hand;
            this.Font = new Font("Segoe UI Semibold", 9.3f, FontStyle.Bold);
            this.Size = new Size(260, 34);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            this.isHovered = true;
            this.Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            this.isHovered = false;
            this.Invalidate();
        }

        protected override void OnClick(EventArgs e)
        {
            base.OnClick(e);
            this.Checked = !this.Checked;
            this.Invalidate();
            if (this.CheckedChanged != null)
            {
                this.CheckedChanged(this, EventArgs.Empty);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (SolidBrush bg = new SolidBrush(ParentSurfaceColor))
            {
                g.FillRectangle(bg, this.ClientRectangle);
            }

            float trackW = 50f;
            float trackH = 28f;
            float trackX = 1f;
            float trackY = (this.Height - trackH) / 2f;
            RectangleF trackRect = new RectangleF(trackX, trackY, trackW, trackH);

            if (this.Checked)
            {
                Color fillCol = isHovered ? M3Geometry.BlendColor(TrackOn, Color.White, 0.1f) : TrackOn;
                using (GraphicsPath trackPath = M3Geometry.CreateRoundedPath(trackRect, trackH / 2f))
                using (SolidBrush trackBrush = new SolidBrush(fillCol))
                {
                    g.FillPath(trackBrush, trackPath);
                }

                // 22x22 active thumb on the right with crisp checkmark
                float thumbSize = 22f;
                float thumbX = trackX + trackW - thumbSize - 3f;
                float thumbY = trackY + (trackH - thumbSize) / 2f;
                RectangleF thumbRect = new RectangleF(thumbX, thumbY, thumbSize, thumbSize);
                using (SolidBrush thumbBrush = new SolidBrush(ThumbOn))
                {
                    g.FillEllipse(thumbBrush, thumbRect);
                }

                // Drawn checkmark inside active thumb
                using (Pen checkPen = new Pen(CheckOn, 2.1f))
                {
                    checkPen.StartCap = LineCap.Round;
                    checkPen.EndCap = LineCap.Round;
                    checkPen.LineJoin = LineJoin.Round;
                    PointF p1 = new PointF(thumbX + 5.8f, thumbY + 11.2f);
                    PointF p2 = new PointF(thumbX + 9.6f, thumbY + 15.0f);
                    PointF p3 = new PointF(thumbX + 16.2f, thumbY + 7.6f);
                    g.DrawLines(checkPen, new PointF[] { p1, p2, p3 });
                }
            }
            else
            {
                RectangleF insetTrack = new RectangleF(trackX + 0.8f, trackY + 0.8f, trackW - 1.6f, trackH - 1.6f);
                using (GraphicsPath trackPath = M3Geometry.CreateRoundedPath(insetTrack, (trackH - 1.6f) / 2f))
                using (SolidBrush trackBrush = new SolidBrush(TrackOff))
                using (Pen borderPen = new Pen(OutlineOff, 1.6f))
                {
                    g.FillPath(trackBrush, trackPath);
                    g.DrawPath(borderPen, trackPath);
                }

                // 14x14 inactive thumb on the left
                float thumbSize = 14f;
                float thumbX = trackX + 7f;
                float thumbY = trackY + (trackH - thumbSize) / 2f;
                using (SolidBrush thumbBrush = new SolidBrush(OutlineOff))
                {
                    g.FillEllipse(thumbBrush, new RectangleF(thumbX, thumbY, thumbSize, thumbSize));
                }
            }

            // Label text
            RectangleF textRect = new RectangleF(trackX + trackW + 10f, 0f, this.Width - (trackW + 12f), this.Height);
            StringFormat sf = new StringFormat();
            sf.Alignment = StringAlignment.Near;
            sf.LineAlignment = StringAlignment.Center;
            sf.FormatFlags = StringFormatFlags.NoWrap;
            using (SolidBrush textBrush = new SolidBrush(LabelColor))
            {
                g.DrawString(this.Text, this.Font, textBrush, textRect, sf);
            }
        }
    }

    internal class CatEyeAvatar : Control
    {
        public Color ParentSurfaceColor = Color.FromArgb(20, 18, 24);

        public CatEyeAvatar()
        {
            this.DoubleBuffered = true;
            this.SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer,
                true
            );
            this.Size = new Size(48, 48);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            using (SolidBrush parentBg = new SolidBrush(ParentSurfaceColor))
            {
                g.FillRectangle(parentBg, this.ClientRectangle);
            }

            float w = this.Width - 1f;
            float h = this.Height - 1f;

            // M3 Expressive primaryContainer squircle badge (#4F378B)
            using (GraphicsPath bgPath = M3Geometry.CreateRoundedPath(new RectangleF(0.5f, 0.5f, w, h), 16f))
            using (LinearGradientBrush bgBrush = new LinearGradientBrush(new RectangleF(0, 0, w, h), Color.FromArgb(92, 64, 160), Color.FromArgb(56, 30, 114), 45f))
            {
                g.FillPath(bgBrush, bgPath);
            }

            // Glowing cat eye iris
            RectangleF iris = new RectangleF(7.5f, 12f, w - 15f, h - 24f);
            using (LinearGradientBrush irisBrush = new LinearGradientBrush(iris, Color.FromArgb(246, 193, 119), Color.FromArgb(234, 179, 8), 45f))
            {
                g.FillEllipse(irisBrush, iris);
            }

            // Vertical cat slit pupil
            RectangleF pupil = new RectangleF((w / 2f) - 3.2f, 14f, 6.4f, h - 28f);
            using (SolidBrush pupilBrush = new SolidBrush(Color.FromArgb(20, 18, 24)))
            {
                g.FillEllipse(pupilBrush, pupil);
            }

            // Specular highlight
            using (SolidBrush specBrush = new SolidBrush(Color.FromArgb(240, 255, 255, 255)))
            {
                g.FillEllipse(specBrush, new RectangleF((w / 2f) + 2.2f, 15f, 4.4f, 4.4f));
            }
        }
    }

    internal class LauncherSettings
    {
        public bool openMonitorOnStartup = true;
        public bool autoStartTunnel = false;
        public bool minimizeToTrayOnClose = false;
    }

    public class MainForm : Form
    {
        private readonly int serverPort;
        private readonly string projectRoot;
        private readonly string serverDir;
        private readonly string settingsFilePath;
        private readonly HttpClient http;
        private readonly JavaScriptSerializer json;

        private IntPtr jobHandle = IntPtr.Zero;
        private Process nodeProcess = null;
        private bool attachedToExistingServer = false;
        private bool serverNotFound = false;
        private bool isExiting = false;
        private bool tunnelBusy = false;
        private bool tunnelRunning = false;
        private bool startupActionsDone = false;
        private readonly bool suppressAutoBrowser;

        private string currentLocalHttpUrl;
        private string currentRemoteHttpUrl = "";
        private string currentPairingLink = "";
        private string currentToken = "";
        private LauncherSettings settings = new LauncherSettings();

        // UI Controls
        private M3Badge badgeServerStatus;
        private M3PillButton btnQuitTop;

        private Label lblLocalUrl;
        private Label lblWsAndViewers;
        private M3Card pnlCameraSubCard;
        private Label lblCameraTitle;
        private Label lblCameraDetails;
        private M3PillButton btnOpenMonitor;
        private M3PillButton btnAdbReverse;

        private M3Badge badgeTunnelStatus;
        private M3PillButton btnToggleTunnel;
        private TextBox txtRemoteUrl;
        private M3PillButton btnCopyRemoteUrl;
        private TextBox txtToken;
        private M3PillButton btnCopyToken;
        private M3PillButton btnNewToken;
        private M3PillButton btnCopyPairingLink;

        private Label lblToast;
        private TextBox txtLogs;
        private M3SwitchRow swOpenOnStartup;
        private M3SwitchRow swAutoStartTunnel;
        private M3SwitchRow swMinimizeToTray;
        private bool suppressSwitchEvents = false;

        private NotifyIcon trayIcon;
        private ToolStripMenuItem trayItemTunnel;
        private System.Windows.Forms.Timer pollTimer;
        private System.Windows.Forms.Timer toastTimer;

        // Material 3 Expressive Dark Tonal Palette (#52)
        private static readonly Color ColSurface = Color.FromArgb(20, 18, 24);                // #141218 surface
        private static readonly Color ColSurfaceLow = Color.FromArgb(29, 27, 32);             // #1D1B20 surfaceContainerLow
        private static readonly Color ColSurfaceContainer = Color.FromArgb(33, 31, 38);       // #211F26 surfaceContainer
        private static readonly Color ColSurfaceHigh = Color.FromArgb(43, 41, 48);            // #2B2930 surfaceContainerHigh
        private static readonly Color ColSurfaceHighest = Color.FromArgb(54, 52, 59);         // #36343B surfaceContainerHighest
        private static readonly Color ColOnSurface = Color.FromArgb(230, 224, 233);           // #E6E0E9 onSurface
        private static readonly Color ColOnSurfaceVariant = Color.FromArgb(202, 196, 208);    // #CAC4D0 onSurfaceVariant

        private static readonly Color ColPrimary = Color.FromArgb(208, 188, 255);             // #D0BCFF primary
        private static readonly Color ColOnPrimary = Color.FromArgb(56, 30, 114);             // #381E72 onPrimary
        private static readonly Color ColPrimaryContainer = Color.FromArgb(79, 55, 139);      // #4F378B primaryContainer
        private static readonly Color ColOnPrimaryContainer = Color.FromArgb(234, 221, 255);  // #EADDFF onPrimaryContainer

        private static readonly Color ColSecondaryContainer = Color.FromArgb(74, 68, 88);     // #4A4458 secondaryContainer
        private static readonly Color ColOnSecondaryContainer = Color.FromArgb(232, 222, 248);// #E8DEF8 onSecondaryContainer

        private static readonly Color ColTertiaryContainer = Color.FromArgb(99, 59, 72);      // #633B48 tertiaryContainer
        private static readonly Color ColOnTertiaryContainer = Color.FromArgb(255, 216, 228); // #FFD8E4 onTertiaryContainer

        private static readonly Color ColEmeraldContainer = Color.FromArgb(30, 58, 47);       // #1E3A2F live container
        private static readonly Color ColEmerald = Color.FromArgb(125, 211, 168);             // #7DD3A8 live text
        private static readonly Color ColAmberContainer = Color.FromArgb(62, 46, 28);         // warm amber container
        private static readonly Color ColAmber = Color.FromArgb(246, 193, 119);               // #F6C177 warm amber
        private static readonly Color ColErrorContainer = Color.FromArgb(88, 33, 38);         // tonal error container
        private static readonly Color ColOnErrorContainer = Color.FromArgb(242, 184, 181);    // #F2B8B5

        public MainForm(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            this.serverPort = ResolveConfiguredPort();
            this.currentLocalHttpUrl = "http://127.0.0.1:" + this.serverPort;
            this.http = new HttpClient();
            this.http.Timeout = TimeSpan.FromSeconds(60);
            this.json = new JavaScriptSerializer();

            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            this.serverDir = ResolveServerDir(exeDir);
            DirectoryInfo parentDir = Directory.GetParent(this.serverDir);
            this.projectRoot = parentDir != null ? parentDir.FullName : this.serverDir;
            this.settingsFilePath = Path.Combine(this.serverDir, "data", "launcher.json");

            LoadSettings();
            this.jobHandle = NativeMethods.CreateKillOnCloseJob();

            string screenshotPath = null;
            int quitAfterSecs = 0;
            bool noBrowserFlag = false;

            if (args != null)
            {
                foreach (string arg in args)
                {
                    if (string.IsNullOrEmpty(arg)) continue;
                    if (arg.Equals("--no-browser", StringComparison.OrdinalIgnoreCase))
                    {
                        noBrowserFlag = true;
                    }
                    else if (arg.StartsWith("--quit-after=", StringComparison.OrdinalIgnoreCase))
                    {
                        int.TryParse(arg.Substring("--quit-after=".Length), out quitAfterSecs);
                        noBrowserFlag = true;
                    }
                    else if (arg.StartsWith("--screenshot=", StringComparison.OrdinalIgnoreCase))
                    {
                        screenshotPath = arg.Substring("--screenshot=".Length).Trim('"');
                        noBrowserFlag = true;
                    }
                }
            }
            this.suppressAutoBrowser = noBrowserFlag;

            BuildUi();
            IntPtr mainHwnd = this.Handle;

            this.Shown += OnFormShown;
            this.FormClosing += OnFormClosing;

            if (!string.IsNullOrEmpty(screenshotPath) || quitAfterSecs > 0)
            {
                int delayMs = quitAfterSecs > 0 ? quitAfterSecs * 1000 : 2800;
                System.Windows.Forms.Timer autoTimer = new System.Windows.Forms.Timer();
                autoTimer.Interval = delayMs;
                autoTimer.Tick += delegate
                {
                    autoTimer.Stop();
                    if (!string.IsNullOrEmpty(screenshotPath))
                    {
                        SaveFormScreenshot(screenshotPath);
                    }
                    if (quitAfterSecs > 0)
                    {
                        ShutdownAndExit();
                    }
                };
                autoTimer.Start();
            }
        }

        public void SaveFormScreenshot(string path)
        {
            try
            {
                using (Bitmap bmp = new Bitmap(this.Width, this.Height))
                {
                    this.DrawToBitmap(bmp, new Rectangle(0, 0, this.Width, this.Height));
                    string dir = Path.GetDirectoryName(Path.GetFullPath(path));
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                    bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            catch (Exception ex)
            {
                AppendLog("[Screenshot] Error: " + ex.Message);
            }
        }

        private static string ResolveServerDir(string exeDir)
        {
            List<string> candidates = new List<string>();

            // 1. Explicit PURRCAM_HOME environment variable override
            string envHome = Environment.GetEnvironmentVariable("PURRCAM_HOME");
            if (!string.IsNullOrWhiteSpace(envHome))
            {
                string trimmed = envHome.Trim().Trim('"');
                candidates.Add(Path.Combine(trimmed, "server"));
                candidates.Add(trimmed);
            }

            // 2. Paths relative to the executable directory (project root, server/, desktop-launcher/)
            if (!string.IsNullOrWhiteSpace(exeDir))
            {
                candidates.Add(Path.Combine(exeDir, "server"));
                candidates.Add(exeDir);
                try { candidates.Add(Path.GetFullPath(Path.Combine(exeDir, ".."))); } catch { }
                try { candidates.Add(Path.GetFullPath(Path.Combine(exeDir, "..", "..", "server"))); } catch { }
            }

            // 3. Build-time embedded default server directory (allows running PurrCam.exe from Desktop or any folder)
            if (!string.IsNullOrWhiteSpace(BuildConfig.DefaultServerDir))
            {
                candidates.Add(BuildConfig.DefaultServerDir);
            }

            // First pass: prefer a directory that already has compiled dist\index.js
            foreach (string dir in candidates)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(dir) && File.Exists(Path.Combine(dir, "dist", "index.js")))
                    {
                        return Path.GetFullPath(dir);
                    }
                }
                catch
                {
                }
            }

            // Second pass: fall back to a directory with package.json
            foreach (string dir in candidates)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(dir) && File.Exists(Path.Combine(dir, "package.json")))
                    {
                        return Path.GetFullPath(dir);
                    }
                }
                catch
                {
                }
            }

            if (!string.IsNullOrWhiteSpace(BuildConfig.DefaultServerDir))
            {
                return BuildConfig.DefaultServerDir;
            }
            return Path.Combine(exeDir, "server");
        }

        private void LoadSettings()
        {
            try
            {
                if (File.Exists(this.settingsFilePath))
                {
                    string raw = File.ReadAllText(this.settingsFilePath, Encoding.UTF8);
                    LauncherSettings loaded = this.json.Deserialize<LauncherSettings>(raw);
                    if (loaded != null) this.settings = loaded;
                }
            }
            catch
            {
                this.settings = new LauncherSettings();
            }
        }

        private void SaveSettings()
        {
            try
            {
                string dir = Path.GetDirectoryName(this.settingsFilePath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                string serialized = this.json.Serialize(this.settings);
                File.WriteAllText(this.settingsFilePath, serialized, Encoding.UTF8);
            }
            catch
            {
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int useDark = 1;
                NativeMethods.DwmSetWindowAttribute(this.Handle, 20, ref useDark, sizeof(int));
            }
            catch
            {
            }
        }

        private void BuildUi()
        {
            this.Text = "PurrCam Control Center";
            this.ClientSize = new Size(940, 710);
            this.MinimumSize = new Size(900, 680);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = ColSurface;
            this.ForeColor = ColOnSurface;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.DoubleBuffered = true;

            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) this.Icon = exeIcon;
            }
            catch
            {
            }

            // --- M3 EXPRESSIVE TOP APP BAR ---
            CatEyeAvatar avatar = new CatEyeAvatar();
            avatar.ParentSurfaceColor = ColSurface;
            avatar.Location = new Point(26, 16);
            this.Controls.Add(avatar);

            Label lblTitle = new Label();
            lblTitle.Text = "PurrCam";
            lblTitle.UseMnemonic = false;
            lblTitle.Font = new Font("Segoe UI Semibold", 17.5f, FontStyle.Bold);
            lblTitle.ForeColor = ColOnSurface;
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(84, 11);
            this.Controls.Add(lblTitle);

            Label lblSubtitle = new Label();
            lblSubtitle.Text = "Material 3 Expressive Desktop Hub  ·  Poco F3 Camera  ·  4G/5G Remote Access";
            lblSubtitle.UseMnemonic = false;
            lblSubtitle.Font = new Font("Segoe UI", 9.3f, FontStyle.Regular);
            lblSubtitle.ForeColor = ColOnSurfaceVariant;
            lblSubtitle.AutoSize = true;
            lblSubtitle.Location = new Point(86, 43);
            this.Controls.Add(lblSubtitle);

            badgeServerStatus = new M3Badge();
            badgeServerStatus.ParentSurfaceColor = ColSurface;
            badgeServerStatus.Text = "Starting on :" + this.serverPort + "...";
            badgeServerStatus.SetTone(ColAmberContainer, ColAmber, true);
            badgeServerStatus.Size = new Size(192, 38);
            badgeServerStatus.Location = new Point(588, 21);
            this.Controls.Add(badgeServerStatus);

            btnQuitTop = new M3PillButton();
            btnQuitTop.ParentSurfaceColor = ColSurface;
            btnQuitTop.Text = "Quit PurrCam";
            btnQuitTop.SetStyleColors(ColErrorContainer, ColOnErrorContainer, false);
            btnQuitTop.Size = new Size(122, 38);
            btnQuitTop.Location = new Point(792, 21);
            btnQuitTop.Click += delegate { ShutdownAndExit(); };
            this.Controls.Add(btnQuitTop);

            // --- LEFT M3 CARD: SERVER & POCO F3 CAMERA STATUS ---
            M3Card cardLeft = new M3Card();
            cardLeft.CornerRadius = 28f;
            cardLeft.SurfaceColor = ColSurfaceContainer;
            cardLeft.ParentSurfaceColor = ColSurface;
            cardLeft.Location = new Point(26, 78);
            cardLeft.Size = new Size(436, 336);
            this.Controls.Add(cardLeft);

            Label lblLeftHeader = new Label();
            lblLeftHeader.Text = "SERVER & POCO F3 CAMERA";
            lblLeftHeader.UseMnemonic = false;
            lblLeftHeader.Font = new Font("Segoe UI Semibold", 8.8f, FontStyle.Bold);
            lblLeftHeader.ForeColor = ColPrimary;
            lblLeftHeader.BackColor = ColSurfaceContainer;
            lblLeftHeader.AutoSize = true;
            lblLeftHeader.Location = new Point(24, 20);
            cardLeft.Controls.Add(lblLeftHeader);

            Label lblLocalCaption = new Label();
            lblLocalCaption.Text = "Local Network App & Signaling Hub";
            lblLocalCaption.UseMnemonic = false;
            lblLocalCaption.ForeColor = ColOnSurfaceVariant;
            lblLocalCaption.BackColor = ColSurfaceContainer;
            lblLocalCaption.AutoSize = true;
            lblLocalCaption.Location = new Point(24, 44);
            cardLeft.Controls.Add(lblLocalCaption);

            lblLocalUrl = new Label();
            lblLocalUrl.Text = "http://127.0.0.1:" + this.serverPort;
            lblLocalUrl.UseMnemonic = false;
            lblLocalUrl.Font = new Font("Consolas", 13f, FontStyle.Bold);
            lblLocalUrl.ForeColor = ColOnSurface;
            lblLocalUrl.BackColor = ColSurfaceContainer;
            lblLocalUrl.AutoSize = true;
            lblLocalUrl.Location = new Point(24, 66);
            cardLeft.Controls.Add(lblLocalUrl);

            M3PillButton btnCopyLocal = new M3PillButton();
            btnCopyLocal.ParentSurfaceColor = ColSurfaceContainer;
            btnCopyLocal.Text = "Copy URL";
            btnCopyLocal.SetStyleColors(ColSecondaryContainer, ColOnSecondaryContainer, false);
            btnCopyLocal.Size = new Size(94, 32);
            btnCopyLocal.Location = new Point(318, 61);
            btnCopyLocal.Click += delegate
            {
                CopyToClipboard(this.currentLocalHttpUrl, "Copied Local URL to clipboard.");
            };
            cardLeft.Controls.Add(btnCopyLocal);

            lblWsAndViewers = new Label();
            lblWsAndViewers.Text = "ws://127.0.0.1:" + this.serverPort + "/ws   ·   0 connected viewers";
            lblWsAndViewers.UseMnemonic = false;
            lblWsAndViewers.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblWsAndViewers.ForeColor = ColOnSurfaceVariant;
            lblWsAndViewers.BackColor = ColSurfaceContainer;
            lblWsAndViewers.AutoSize = true;
            lblWsAndViewers.Location = new Point(24, 96);
            cardLeft.Controls.Add(lblWsAndViewers);

            // Inner Tonal Camera Container (20px rounded, #2B2930 surfaceContainerHigh)
            pnlCameraSubCard = new M3Card();
            pnlCameraSubCard.CornerRadius = 20f;
            pnlCameraSubCard.SurfaceColor = ColSurfaceHigh;
            pnlCameraSubCard.ParentSurfaceColor = ColSurfaceContainer;
            pnlCameraSubCard.Location = new Point(22, 126);
            pnlCameraSubCard.Size = new Size(392, 86);
            cardLeft.Controls.Add(pnlCameraSubCard);

            lblCameraTitle = new Label();
            lblCameraTitle.Text = "○  Offline — waiting for Poco F3";
            lblCameraTitle.UseMnemonic = false;
            lblCameraTitle.Font = new Font("Segoe UI Semibold", 10.5f, FontStyle.Bold);
            lblCameraTitle.ForeColor = ColAmber;
            lblCameraTitle.BackColor = ColSurfaceHigh;
            lblCameraTitle.AutoSize = true;
            lblCameraTitle.Location = new Point(18, 16);
            pnlCameraSubCard.Controls.Add(lblCameraTitle);

            lblCameraDetails = new Label();
            lblCameraDetails.Text = "Launch Camera Mode on Poco F3 or connect via USB ADB Reverse";
            lblCameraDetails.UseMnemonic = false;
            lblCameraDetails.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblCameraDetails.ForeColor = ColOnSurfaceVariant;
            lblCameraDetails.BackColor = ColSurfaceHigh;
            lblCameraDetails.AutoSize = false;
            lblCameraDetails.Size = new Size(356, 36);
            lblCameraDetails.Location = new Point(18, 44);
            pnlCameraSubCard.Controls.Add(lblCameraDetails);

            // Hero M3 Expressive Primary Button (shape-morphed squircle pill #D0BCFF / #381E72)
            btnOpenMonitor = new M3PillButton();
            btnOpenMonitor.ParentSurfaceColor = ColSurfaceContainer;
            btnOpenMonitor.Text = "Open Live Monitor Window";
            btnOpenMonitor.Font = new Font("Segoe UI Semibold", 10.5f, FontStyle.Bold);
            btnOpenMonitor.SetStyleColors(ColPrimary, ColOnPrimary, true);
            btnOpenMonitor.Size = new Size(392, 44);
            btnOpenMonitor.Location = new Point(22, 226);
            btnOpenMonitor.Click += delegate { OpenLiveMonitorWindow(); };
            cardLeft.Controls.Add(btnOpenMonitor);

            btnAdbReverse = new M3PillButton();
            btnAdbReverse.ParentSurfaceColor = ColSurfaceContainer;
            btnAdbReverse.Text = "Connect Poco F3 via USB (ADB Reverse)";
            btnAdbReverse.SetStyleColors(ColSecondaryContainer, ColOnSecondaryContainer, false);
            btnAdbReverse.Size = new Size(392, 38);
            btnAdbReverse.Location = new Point(22, 279);
            btnAdbReverse.Click += delegate { RunAdbReverseAsync(); };
            cardLeft.Controls.Add(btnAdbReverse);

            // --- RIGHT M3 CARD: REMOTE ACCESS (4G/5G) & SECURITY ---
            M3Card cardRight = new M3Card();
            cardRight.CornerRadius = 28f;
            cardRight.SurfaceColor = ColSurfaceContainer;
            cardRight.ParentSurfaceColor = ColSurface;
            cardRight.Location = new Point(478, 78);
            cardRight.Size = new Size(436, 336);
            this.Controls.Add(cardRight);

            Label lblRightHeader = new Label();
            lblRightHeader.Text = "REMOTE ACCESS (4G / 5G OUTSIDE LAN)";
            lblRightHeader.UseMnemonic = false;
            lblRightHeader.Font = new Font("Segoe UI Semibold", 8.8f, FontStyle.Bold);
            lblRightHeader.ForeColor = ColPrimary;
            lblRightHeader.BackColor = ColSurfaceContainer;
            lblRightHeader.AutoSize = true;
            lblRightHeader.Location = new Point(24, 20);
            cardRight.Controls.Add(lblRightHeader);

            badgeTunnelStatus = new M3Badge();
            badgeTunnelStatus.ParentSurfaceColor = ColSurfaceContainer;
            badgeTunnelStatus.Text = "Tunnel Stopped";
            badgeTunnelStatus.SetTone(ColSurfaceHigh, ColOnSurfaceVariant, false);
            badgeTunnelStatus.Size = new Size(198, 36);
            badgeTunnelStatus.Location = new Point(22, 45);
            cardRight.Controls.Add(badgeTunnelStatus);

            btnToggleTunnel = new M3PillButton();
            btnToggleTunnel.ParentSurfaceColor = ColSurfaceContainer;
            btnToggleTunnel.Text = "Start Remote Tunnel";
            btnToggleTunnel.SetStyleColors(ColEmeraldContainer, ColEmerald, false);
            btnToggleTunnel.Size = new Size(184, 36);
            btnToggleTunnel.Location = new Point(230, 45);
            btnToggleTunnel.Click += delegate { ToggleRemoteTunnelAsync(); };
            cardRight.Controls.Add(btnToggleTunnel);

            Label lblRemoteUrlCap = new Label();
            lblRemoteUrlCap.Text = "Public HTTPS / WSS Tunnel URL (Cloudflare Quick Tunnel)";
            lblRemoteUrlCap.UseMnemonic = false;
            lblRemoteUrlCap.ForeColor = ColOnSurfaceVariant;
            lblRemoteUrlCap.BackColor = ColSurfaceContainer;
            lblRemoteUrlCap.AutoSize = true;
            lblRemoteUrlCap.Location = new Point(24, 90);
            cardRight.Controls.Add(lblRemoteUrlCap);

            // Borderless M3 Tonal Input Pill for Remote URL
            M3Card pillRemoteUrl = new M3Card();
            pillRemoteUrl.CornerRadius = 16f;
            pillRemoteUrl.SurfaceColor = ColSurfaceHigh;
            pillRemoteUrl.ParentSurfaceColor = ColSurfaceContainer;
            pillRemoteUrl.Location = new Point(22, 113);
            pillRemoteUrl.Size = new Size(294, 34);
            cardRight.Controls.Add(pillRemoteUrl);

            txtRemoteUrl = new TextBox();
            txtRemoteUrl.ReadOnly = true;
            txtRemoteUrl.BorderStyle = BorderStyle.None;
            txtRemoteUrl.BackColor = ColSurfaceHigh;
            txtRemoteUrl.ForeColor = ColOnSurface;
            txtRemoteUrl.Font = new Font("Consolas", 9.6f, FontStyle.Regular);
            txtRemoteUrl.Text = "Tunnel stopped — click Start Tunnel";
            txtRemoteUrl.Location = new Point(12, 9);
            txtRemoteUrl.Size = new Size(270, 18);
            pillRemoteUrl.Controls.Add(txtRemoteUrl);

            btnCopyRemoteUrl = new M3PillButton();
            btnCopyRemoteUrl.ParentSurfaceColor = ColSurfaceContainer;
            btnCopyRemoteUrl.Text = "Copy URL";
            btnCopyRemoteUrl.SetStyleColors(ColSecondaryContainer, ColOnSecondaryContainer, false);
            btnCopyRemoteUrl.Size = new Size(90, 34);
            btnCopyRemoteUrl.Location = new Point(324, 113);
            btnCopyRemoteUrl.Click += delegate
            {
                if (!string.IsNullOrEmpty(this.currentRemoteHttpUrl))
                {
                    CopyToClipboard(this.currentRemoteHttpUrl, "Copied Remote HTTPS URL to clipboard.");
                }
                else
                {
                    ShowToast("Start the remote tunnel first to get a public URL.", true);
                }
            };
            cardRight.Controls.Add(btnCopyRemoteUrl);

            Label lblTokenCap = new Label();
            lblTokenCap.Text = "Remote Access Security Token (required outside home LAN)";
            lblTokenCap.UseMnemonic = false;
            lblTokenCap.ForeColor = ColOnSurfaceVariant;
            lblTokenCap.BackColor = ColSurfaceContainer;
            lblTokenCap.AutoSize = true;
            lblTokenCap.Location = new Point(24, 155);
            cardRight.Controls.Add(lblTokenCap);

            // Borderless M3 Tonal Input Pill for Token
            M3Card pillToken = new M3Card();
            pillToken.CornerRadius = 16f;
            pillToken.SurfaceColor = ColSurfaceHigh;
            pillToken.ParentSurfaceColor = ColSurfaceContainer;
            pillToken.Location = new Point(22, 178);
            pillToken.Size = new Size(192, 34);
            cardRight.Controls.Add(pillToken);

            txtToken = new TextBox();
            txtToken.BorderStyle = BorderStyle.None;
            txtToken.BackColor = ColSurfaceHigh;
            txtToken.ForeColor = ColPrimary;
            txtToken.Font = new Font("Consolas", 10f, FontStyle.Bold);
            txtToken.Location = new Point(12, 8);
            txtToken.Size = new Size(168, 18);
            txtToken.KeyDown += delegate(object s, KeyEventArgs ke)
            {
                if (ke.KeyCode == Keys.Enter)
                {
                    ke.SuppressKeyPress = true;
                    SaveCustomTokenAsync(txtToken.Text.Trim());
                }
            };
            pillToken.Controls.Add(txtToken);

            btnCopyToken = new M3PillButton();
            btnCopyToken.ParentSurfaceColor = ColSurfaceContainer;
            btnCopyToken.Text = "Copy Token";
            btnCopyToken.SetStyleColors(ColSecondaryContainer, ColOnSecondaryContainer, false);
            btnCopyToken.Size = new Size(96, 34);
            btnCopyToken.Location = new Point(220, 178);
            btnCopyToken.Click += delegate
            {
                string tok = txtToken.Text.Trim();
                if (!string.IsNullOrEmpty(tok))
                {
                    CopyToClipboard(tok, "Copied Access Token to clipboard.");
                }
                else
                {
                    ShowToast("No token set yet — click New Token or Start Tunnel.", true);
                }
            };
            cardRight.Controls.Add(btnCopyToken);

            btnNewToken = new M3PillButton();
            btnNewToken.ParentSurfaceColor = ColSurfaceContainer;
            btnNewToken.Text = "New Token";
            btnNewToken.SetStyleColors(ColPrimaryContainer, ColOnPrimaryContainer, false);
            btnNewToken.Size = new Size(92, 34);
            btnNewToken.Location = new Point(322, 178);
            btnNewToken.Click += delegate { GenerateNewTokenAsync(); };
            cardRight.Controls.Add(btnNewToken);

            Label lblPairingHint = new Label();
            lblPairingHint.Text = "One-tap phone setup (Local Wi-Fi + Remote 4G/5G + Token)";
            lblPairingHint.UseMnemonic = false;
            lblPairingHint.ForeColor = ColOnSurfaceVariant;
            lblPairingHint.BackColor = ColSurfaceContainer;
            lblPairingHint.AutoSize = true;
            lblPairingHint.Location = new Point(24, 220);
            cardRight.Controls.Add(lblPairingHint);

            btnCopyPairingLink = new M3PillButton();
            btnCopyPairingLink.ParentSurfaceColor = ColSurfaceContainer;
            btnCopyPairingLink.Text = "Copy Phone Pairing Link (purrcam://)";
            btnCopyPairingLink.Font = new Font("Segoe UI Semibold", 10.2f, FontStyle.Bold);
            btnCopyPairingLink.SetStyleColors(ColTertiaryContainer, ColOnTertiaryContainer, true);
            btnCopyPairingLink.Size = new Size(392, 44);
            btnCopyPairingLink.Location = new Point(22, 244);
            btnCopyPairingLink.Click += delegate
            {
                if (!string.IsNullOrEmpty(this.currentPairingLink))
                {
                    CopyToClipboard(this.currentPairingLink, "Copied purrcam:// pairing link! Send it to your phone.");
                }
                else
                {
                    ShowToast("Waiting for server pairing link...", true);
                }
            };
            cardRight.Controls.Add(btnCopyPairingLink);

            Label lblPairingSub = new Label();
            lblPairingSub.Text = "Paste in PurrCam Android app -> Settings -> Paste Pairing Link";
            lblPairingSub.UseMnemonic = false;
            lblPairingSub.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblPairingSub.ForeColor = ColOnSurfaceVariant;
            lblPairingSub.BackColor = ColSurfaceContainer;
            lblPairingSub.AutoSize = true;
            lblPairingSub.Location = new Point(24, 297);
            cardRight.Controls.Add(lblPairingSub);

            // --- BOTTOM M3 CARD: LIVE LOGS & M3 EXPRESSIVE SWITCHES ---
            M3Card cardBottom = new M3Card();
            cardBottom.CornerRadius = 28f;
            cardBottom.SurfaceColor = ColSurfaceContainer;
            cardBottom.ParentSurfaceColor = ColSurface;
            cardBottom.Location = new Point(26, 428);
            cardBottom.Size = new Size(888, 258);
            this.Controls.Add(cardBottom);

            Label lblLogsHeader = new Label();
            lblLogsHeader.Text = "LIVE SERVER & TUNNEL LOGS";
            lblLogsHeader.UseMnemonic = false;
            lblLogsHeader.Font = new Font("Segoe UI Semibold", 8.8f, FontStyle.Bold);
            lblLogsHeader.ForeColor = ColPrimary;
            lblLogsHeader.BackColor = ColSurfaceContainer;
            lblLogsHeader.AutoSize = true;
            lblLogsHeader.Location = new Point(24, 18);
            cardBottom.Controls.Add(lblLogsHeader);

            lblToast = new Label();
            lblToast.Text = "";
            lblToast.UseMnemonic = false;
            lblToast.Font = new Font("Segoe UI Semibold", 9.2f, FontStyle.Bold);
            lblToast.ForeColor = ColEmerald;
            lblToast.BackColor = ColSurfaceContainer;
            lblToast.AutoSize = true;
            lblToast.Location = new Point(230, 17);
            cardBottom.Controls.Add(lblToast);

            M3PillButton btnClearLogs = new M3PillButton();
            btnClearLogs.ParentSurfaceColor = ColSurfaceContainer;
            btnClearLogs.Text = "Clear Logs";
            btnClearLogs.Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold);
            btnClearLogs.SetStyleColors(ColSurfaceHigh, ColOnSurfaceVariant, false);
            btnClearLogs.Size = new Size(92, 28);
            btnClearLogs.Location = new Point(772, 13);
            btnClearLogs.Click += delegate { txtLogs.Clear(); };
            cardBottom.Controls.Add(btnClearLogs);

            // Rounded Tonal Log Container (20px, #141218 surface, zero border)
            M3Card logContainer = new M3Card();
            logContainer.CornerRadius = 20f;
            logContainer.SurfaceColor = ColSurface;
            logContainer.ParentSurfaceColor = ColSurfaceContainer;
            logContainer.Location = new Point(22, 46);
            logContainer.Size = new Size(844, 152);
            cardBottom.Controls.Add(logContainer);

            txtLogs = new TextBox();
            txtLogs.Multiline = true;
            txtLogs.ReadOnly = true;
            txtLogs.ScrollBars = ScrollBars.Vertical;
            txtLogs.BorderStyle = BorderStyle.None;
            txtLogs.BackColor = ColSurface;
            txtLogs.ForeColor = Color.FromArgb(216, 206, 248);
            txtLogs.Font = new Font("Consolas", 9.2f, FontStyle.Regular);
            txtLogs.Location = new Point(14, 10);
            txtLogs.Size = new Size(816, 132);
            logContainer.Controls.Add(txtLogs);

            // Authentic M3 Expressive Switches with Checkmarks
            suppressSwitchEvents = true;

            swOpenOnStartup = new M3SwitchRow();
            swOpenOnStartup.ParentSurfaceColor = ColSurfaceContainer;
            swOpenOnStartup.Text = "Open Monitor UI on startup";
            swOpenOnStartup.Checked = this.settings.openMonitorOnStartup;
            swOpenOnStartup.Size = new Size(256, 34);
            swOpenOnStartup.Location = new Point(24, 210);
            swOpenOnStartup.CheckedChanged += delegate
            {
                if (suppressSwitchEvents) return;
                this.settings.openMonitorOnStartup = swOpenOnStartup.Checked;
                SaveSettings();
            };
            cardBottom.Controls.Add(swOpenOnStartup);

            swAutoStartTunnel = new M3SwitchRow();
            swAutoStartTunnel.ParentSurfaceColor = ColSurfaceContainer;
            swAutoStartTunnel.Text = "Auto-start Remote Tunnel";
            swAutoStartTunnel.Checked = this.settings.autoStartTunnel;
            swAutoStartTunnel.Size = new Size(250, 34);
            swAutoStartTunnel.Location = new Point(312, 210);
            swAutoStartTunnel.CheckedChanged += delegate
            {
                if (suppressSwitchEvents) return;
                this.settings.autoStartTunnel = swAutoStartTunnel.Checked;
                SaveSettings();
                SyncAutoStartTunnelToServerAsync(swAutoStartTunnel.Checked);
            };
            cardBottom.Controls.Add(swAutoStartTunnel);

            swMinimizeToTray = new M3SwitchRow();
            swMinimizeToTray.ParentSurfaceColor = ColSurfaceContainer;
            swMinimizeToTray.Text = "Minimize to System Tray on close";
            swMinimizeToTray.Checked = this.settings.minimizeToTrayOnClose;
            swMinimizeToTray.Size = new Size(280, 34);
            swMinimizeToTray.Location = new Point(584, 210);
            swMinimizeToTray.CheckedChanged += delegate
            {
                if (suppressSwitchEvents) return;
                this.settings.minimizeToTrayOnClose = swMinimizeToTray.Checked;
                SaveSettings();
            };
            cardBottom.Controls.Add(swMinimizeToTray);

            suppressSwitchEvents = false;

            toastTimer = new System.Windows.Forms.Timer();
            toastTimer.Interval = 4000;
            toastTimer.Tick += delegate
            {
                toastTimer.Stop();
                lblToast.Text = "";
            };
        }

        private void SetupTrayIcon()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Live Monitor", null, delegate { OpenLiveMonitorWindow(); });
            menu.Items.Add("Show Control Center", null, delegate { ShowControlCenter(); });
            menu.Items.Add(new ToolStripSeparator());

            trayItemTunnel = new ToolStripMenuItem("Start Remote Tunnel", null, delegate { ToggleRemoteTunnelAsync(); });
            menu.Items.Add(trayItemTunnel);

            menu.Items.Add("Copy Phone Pairing Link", null, delegate
            {
                if (!string.IsNullOrEmpty(this.currentPairingLink))
                {
                    CopyToClipboard(this.currentPairingLink, "Copied purrcam:// pairing link to clipboard.");
                }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit PurrCam", null, delegate { ShutdownAndExit(); });

            trayIcon = new NotifyIcon();
            trayIcon.Text = "PurrCam Control Center";
            trayIcon.Icon = this.Icon != null ? this.Icon : SystemIcons.Application;
            trayIcon.ContextMenuStrip = menu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { ShowControlCenter(); };
        }

        private void ShowControlCenter()
        {
            this.Show();
            if (this.WindowState == FormWindowState.Minimized)
            {
                this.WindowState = FormWindowState.Normal;
            }
            this.Activate();
        }

        private void OnFormShown(object sender, EventArgs e)
        {
            SetupTrayIcon();
            this.Activate();
            NativeMethods.HideAuxiliaryTopLevelWindows(this.Handle);
            AppendLog("[PurrCam] Material 3 Expressive Control Center initialized. Root: " + this.projectRoot);
            Task.Run(delegate { EnsureServerRunningAsync(); });

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 2000;
            pollTimer.Tick += delegate
            {
                NativeMethods.HideAuxiliaryTopLevelWindows(this.Handle);
                PollServerStatusAsync();
            };
            pollTimer.Start();
        }

        private async void EnsureServerRunningAsync()
        {
            if (await IsPurrCamRespondingAsync())
            {
                this.attachedToExistingServer = true;
                AppendLog("[Supervisor] Attached to existing PurrCam server on port " + this.serverPort + ".");
                PollServerStatusAsync();
                return;
            }

            string nodeExe = FindNodeExecutable();
            if (string.IsNullOrEmpty(nodeExe))
            {
                this.serverNotFound = true;
                AppendLog("[Supervisor] ERROR: Node.js (node.exe) was not found. Please install Node.js 20+ from https://nodejs.org");
                ShowServerNotFoundState("Node.js not found — install Node.js 20+ from https://nodejs.org", true);
                return;
            }

            string indexJs = Path.Combine(this.serverDir, "dist", "index.js");
            if (!File.Exists(indexJs))
            {
                this.serverNotFound = true;
                AppendLog("[Supervisor] ERROR: " + indexJs + " not found. Keep PurrCam.exe next to the server/ folder or set PURRCAM_HOME.");
                ShowServerNotFoundState("Missing " + indexJs, false);
                return;
            }

            try
            {
                AppendLog("[Supervisor] Starting background Node server (" + nodeExe + " dist\\index.js)...");
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = "\"" + indexJs + "\"";
                psi.WorkingDirectory = this.serverDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["PORT"] = this.serverPort.ToString();

                Process proc = new Process();
                proc.StartInfo = psi;
                proc.EnableRaisingEvents = true;
                proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs ev)
                {
                    if (!string.IsNullOrWhiteSpace(ev.Data))
                    {
                        AppendLog(ev.Data);
                    }
                };
                proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs ev)
                {
                    if (!string.IsNullOrWhiteSpace(ev.Data))
                    {
                        AppendLog("[stderr] " + ev.Data);
                    }
                };
                proc.Exited += delegate
                {
                    if (!this.isExiting)
                    {
                        AppendLog("[Supervisor] Node server process exited.");
                    }
                };

                proc.Start();
                if (this.jobHandle != IntPtr.Zero)
                {
                    NativeMethods.AssignProcessToJobObject(this.jobHandle, proc.Handle);
                }
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                this.nodeProcess = proc;

                for (int i = 0; i < 25; i++)
                {
                    await Task.Delay(200);
                    if (await IsPurrCamRespondingAsync())
                    {
                        AppendLog("[Supervisor] PurrCam server is live on port " + this.serverPort + ".");
                        PollServerStatusAsync();
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                AppendLog("[Supervisor] Failed to launch Node server: " + ex.Message);
            }
        }

        private async Task<bool> IsPurrCamRespondingAsync()
        {
            try
            {
                using (CancellationTokenSource cts = new CancellationTokenSource(1000))
                {
                    HttpResponseMessage resp = await this.http.GetAsync("http://127.0.0.1:" + this.serverPort + "/api/info", cts.Token);
                    return resp.IsSuccessStatusCode;
                }
            }
            catch
            {
                return false;
            }
        }

        private async void PollServerStatusAsync()
        {
            if (this.isExiting) return;
            try
            {
                string baseUrl = "http://127.0.0.1:" + this.serverPort;
                string infoJson = await this.http.GetStringAsync(baseUrl + "/api/info");
                Dictionary<string, object> info = this.json.Deserialize<Dictionary<string, object>>(infoJson);

                string cfgJson = await this.http.GetStringAsync(baseUrl + "/api/remote/config");
                Dictionary<string, object> cfg = this.json.Deserialize<Dictionary<string, object>>(cfgJson);

                if (this.IsDisposed || !this.IsHandleCreated) return;
                this.BeginInvoke((MethodInvoker)delegate
                {
                    UpdateDashboardUi(info, cfg);
                });
            }
            catch
            {
                if (this.IsDisposed || !this.IsHandleCreated) return;
                this.BeginInvoke((MethodInvoker)delegate
                {
                    if (this.serverNotFound)
                    {
                        badgeServerStatus.Text = "Server Not Found";
                        badgeServerStatus.SetTone(ColErrorContainer, ColOnErrorContainer, true);
                    }
                    else
                    {
                        badgeServerStatus.Text = "Server Offline";
                        badgeServerStatus.SetTone(ColErrorContainer, ColOnErrorContainer, true);
                    }
                });
            }
        }

        private void ShowServerNotFoundState(string detail, bool isMissingNode)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            this.BeginInvoke((MethodInvoker)delegate
            {
                badgeServerStatus.Text = isMissingNode ? "Node.js Required" : "Server Not Found";
                badgeServerStatus.SetTone(ColErrorContainer, ColOnErrorContainer, true);
                lblCameraTitle.Text = isMissingNode ? "✕  Node.js Not Installed" : "✕  Server Not Found";
                lblCameraTitle.ForeColor = ColOnErrorContainer;
                lblCameraDetails.Text = detail;
                ShowControlCenter();

                if (isMissingNode && !this.suppressAutoBrowser)
                {
                    DialogResult dr = MessageBox.Show(
                        this,
                        "PurrCam requires Node.js 20 or newer to run its local hub server.\n\nWould you like to open https://nodejs.org to download Node.js?",
                        "PurrCam — Node.js Required",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information
                    );
                    if (dr == DialogResult.Yes)
                    {
                        try { Process.Start("https://nodejs.org"); } catch { }
                    }
                }
            });
        }

        private void UpdateDashboardUi(Dictionary<string, object> info, Dictionary<string, object> cfg)
        {
            if (info == null) return;

            badgeServerStatus.Text = "Live on :" + this.serverPort;
            badgeServerStatus.SetTone(ColEmeraldContainer, ColEmerald, true);

            string primaryIp = "127.0.0.1";
            if (info.ContainsKey("lanIps") && info["lanIps"] is IList)
            {
                IList ips = (IList)info["lanIps"];
                if (ips.Count > 0 && ips[0] != null)
                {
                    primaryIp = ips[0].ToString();
                }
            }
            this.currentLocalHttpUrl = "http://" + primaryIp + ":" + this.serverPort;
            lblLocalUrl.Text = this.currentLocalHttpUrl;

            int viewerCount = GetInt(info, "viewerCount", 0);
            string wsUrl = GetString(info, "wsUrl", "ws://" + primaryIp + ":" + this.serverPort + "/ws");
            lblWsAndViewers.Text = string.Format("{0}   ·   {1} connected viewer{2}", wsUrl, viewerCount, viewerCount == 1 ? "" : "s");

            // Camera status
            bool camOnline = GetBool(info, "cameraOnline", false);
            Dictionary<string, object> camObj = GetDict(info, "camera");
            if (camOnline && camObj != null)
            {
                string devName = GetString(camObj, "deviceName", "Poco F3");
                string lensLabel = ResolveActiveLensLabel(camObj);
                Dictionary<string, object> tele = GetDict(camObj, "telemetry");

                string battPart = "";
                string tempPart = "";
                if (tele != null)
                {
                    int batt = GetInt(tele, "batteryPct", -1);
                    bool charging = GetBool(tele, "charging", false);
                    if (batt >= 0) battPart = string.Format("  ·  Battery {0}%{1}", batt, charging ? " ⚡" : "");

                    if (tele.ContainsKey("batteryTempC") && tele["batteryTempC"] != null)
                    {
                        double temp = Convert.ToDouble(tele["batteryTempC"]);
                        tempPart = string.Format("  ·  {0:0.0}°C", temp);
                    }
                }

                lblCameraTitle.Text = "●  Online · " + devName;
                lblCameraTitle.ForeColor = ColEmerald;
                lblCameraDetails.Text = string.Format("Active Lens: {0}{1}{2}", lensLabel, battPart, tempPart);
            }
            else
            {
                lblCameraTitle.Text = "○  Offline — waiting for Poco F3";
                lblCameraTitle.ForeColor = ColAmber;
                lblCameraDetails.Text = "Launch Camera Mode on Poco F3 or click USB ADB Reverse below";
            }

            // Remote Tunnel Status
            Dictionary<string, object> remote = GetDict(info, "remote");
            if (remote != null)
            {
                string status = GetString(remote, "status", "stopped");
                string provider = GetString(remote, "provider", "none");
                string rUrl = GetString(remote, "url", "");
                string rErr = GetString(remote, "error", "");

                this.tunnelRunning = (status == "running");
                this.currentRemoteHttpUrl = rUrl;

                if (status == "running" && !string.IsNullOrEmpty(rUrl))
                {
                    string provLabel = provider == "cloudflare" ? "Cloudflare HTTPS" : provider.ToUpperInvariant();
                    badgeTunnelStatus.Text = "Active · " + provLabel;
                    badgeTunnelStatus.SetTone(ColEmeraldContainer, ColEmerald, true);
                    txtRemoteUrl.Text = rUrl;
                    if (!this.tunnelBusy)
                    {
                        btnToggleTunnel.Text = "Stop Tunnel";
                        btnToggleTunnel.SetStyleColors(ColErrorContainer, ColOnErrorContainer, true);
                    }
                    trayItemTunnel.Text = "Stop Remote Tunnel";
                }
                else if (status == "starting" || this.tunnelBusy)
                {
                    badgeTunnelStatus.Text = "Starting Tunnel...";
                    badgeTunnelStatus.SetTone(ColAmberContainer, ColAmber, true);
                    txtRemoteUrl.Text = "Connecting to Cloudflare Edge...";
                }
                else if (status == "error")
                {
                    badgeTunnelStatus.Text = "Tunnel Error";
                    badgeTunnelStatus.SetTone(ColErrorContainer, ColOnErrorContainer, true);
                    txtRemoteUrl.Text = !string.IsNullOrEmpty(rErr) ? rErr : "Tunnel failed to start";
                    btnToggleTunnel.Text = "Start Remote Tunnel";
                    btnToggleTunnel.SetStyleColors(ColEmeraldContainer, ColEmerald, false);
                    trayItemTunnel.Text = "Start Remote Tunnel";
                }
                else
                {
                    badgeTunnelStatus.Text = "Tunnel Stopped";
                    badgeTunnelStatus.SetTone(ColSurfaceHigh, ColOnSurfaceVariant, false);
                    txtRemoteUrl.Text = "Tunnel stopped — click Start Tunnel";
                    if (!this.tunnelBusy)
                    {
                        btnToggleTunnel.Text = "Start Remote Tunnel";
                        btnToggleTunnel.SetStyleColors(ColEmeraldContainer, ColEmerald, false);
                    }
                    trayItemTunnel.Text = "Start Remote Tunnel";
                }
            }

            // Config & Pairing Link
            if (cfg != null)
            {
                string tok = GetString(cfg, "token", "");
                this.currentToken = tok;
                if (!txtToken.Focused && txtToken.Text != tok)
                {
                    txtToken.Text = tok;
                }
                this.currentPairingLink = GetString(cfg, "pairingLink", "");

                bool autoTunnel = GetBool(cfg, "autoStartTunnel", false);
                if (swAutoStartTunnel.Checked != autoTunnel)
                {
                    suppressSwitchEvents = true;
                    swAutoStartTunnel.Checked = autoTunnel;
                    swAutoStartTunnel.Invalidate();
                    suppressSwitchEvents = false;
                }
            }

            if (!this.startupActionsDone)
            {
                this.startupActionsDone = true;
                if (this.settings.openMonitorOnStartup && !this.suppressAutoBrowser)
                {
                    OpenLiveMonitorWindow();
                }
                if (this.settings.autoStartTunnel && !this.tunnelRunning && !this.tunnelBusy)
                {
                    ToggleRemoteTunnelAsync();
                }
            }
        }

        private static string ResolveActiveLensLabel(Dictionary<string, object> camObj)
        {
            Dictionary<string, object> state = GetDict(camObj, "state");
            string activeId = state != null ? GetString(state, "activeLensId", "") : "";
            if (camObj.ContainsKey("lenses") && camObj["lenses"] is IList)
            {
                IList lenses = (IList)camObj["lenses"];
                foreach (object item in lenses)
                {
                    Dictionary<string, object> lens = item as Dictionary<string, object>;
                    if (lens != null && GetString(lens, "id", "") == activeId)
                    {
                        return GetString(lens, "label", activeId);
                    }
                }
            }
            return !string.IsNullOrEmpty(activeId) ? activeId : "1× Main";
        }

        private async void ToggleRemoteTunnelAsync()
        {
            if (this.tunnelBusy) return;
            this.tunnelBusy = true;
            btnToggleTunnel.Enabled = false;

            string baseUrl = "http://127.0.0.1:" + this.serverPort;
            try
            {
                if (this.tunnelRunning)
                {
                    btnToggleTunnel.Text = "Stopping...";
                    AppendLog("[Remote] Stopping Cloudflare Quick Tunnel...");
                    StringContent emptyBody = new StringContent("{}", Encoding.UTF8, "application/json");
                    await this.http.PostAsync(baseUrl + "/api/remote/stop", emptyBody);
                    ShowToast("Remote tunnel stopped.", false);
                }
                else
                {
                    btnToggleTunnel.Text = "Starting...";
                    badgeTunnelStatus.Text = "Starting Tunnel...";
                    badgeTunnelStatus.SetTone(ColAmberContainer, ColAmber, true);
                    txtRemoteUrl.Text = "Starting cloudflared tunnel...";
                    AppendLog("[Remote] Starting Cloudflare Quick Tunnel...");

                    StringContent body = new StringContent("{\"provider\":\"cloudflare\"}", Encoding.UTF8, "application/json");
                    HttpResponseMessage resp = await this.http.PostAsync(baseUrl + "/api/remote/start", body);
                    string respText = await resp.Content.ReadAsStringAsync();
                    if (resp.IsSuccessStatusCode)
                    {
                        ShowToast("Remote tunnel active! Ready for 4G/5G.", false);
                    }
                    else
                    {
                        AppendLog("[Remote] Error starting tunnel: " + respText);
                        ShowToast("Failed to start tunnel. Check logs.", true);
                    }
                }
            }
            catch (Exception ex)
            {
                AppendLog("[Remote] Request error: " + ex.Message);
                ShowToast("Tunnel request failed: " + ex.Message, true);
            }
            finally
            {
                this.tunnelBusy = false;
                btnToggleTunnel.Enabled = true;
                PollServerStatusAsync();
            }
        }

        private async void GenerateNewTokenAsync()
        {
            byte[] rand = new byte[24];
            using (System.Security.Cryptography.RNGCryptoServiceProvider rng = new System.Security.Cryptography.RNGCryptoServiceProvider())
            {
                rng.GetBytes(rand);
            }
            string newTok = Convert.ToBase64String(rand).Replace('+', '-').Replace('/', '_').TrimEnd('=');
            txtToken.Text = newTok;
            await SaveTokenInternalAsync(newTok);
        }

        private async void SaveCustomTokenAsync(string token)
        {
            await SaveTokenInternalAsync(token);
        }

        private async Task SaveTokenInternalAsync(string token)
        {
            try
            {
                string baseUrl = "http://127.0.0.1:" + this.serverPort;
                string payload = this.json.Serialize(new Dictionary<string, object> { { "token", token } });
                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Put, baseUrl + "/api/remote/config");
                req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
                HttpResponseMessage resp = await this.http.SendAsync(req);
                if (resp.IsSuccessStatusCode)
                {
                    AppendLog("[Security] Updated Remote Access Token.");
                    ShowToast("Access Token saved.", false);
                    PollServerStatusAsync();
                }
            }
            catch (Exception ex)
            {
                ShowToast("Failed to save token: " + ex.Message, true);
            }
        }

        private async void SyncAutoStartTunnelToServerAsync(bool enabled)
        {
            try
            {
                string baseUrl = "http://127.0.0.1:" + this.serverPort;
                string payload = this.json.Serialize(new Dictionary<string, object> { { "autoStartTunnel", enabled } });
                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Put, baseUrl + "/api/remote/config");
                req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
                await this.http.SendAsync(req);
            }
            catch
            {
            }
        }

        private void OpenLiveMonitorWindow()
        {
            string url = "http://127.0.0.1:" + this.serverPort;
            string browser = FindAppBrowser();
            try
            {
                if (!string.IsNullOrEmpty(browser))
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = browser;
                    psi.Arguments = "--app=" + url + " --window-size=1380,860";
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                    AppendLog("[UI] Opened M3 Expressive Live Monitor window (" + Path.GetFileName(browser) + " --app=" + url + ").");
                }
                else
                {
                    Process.Start(url);
                    AppendLog("[UI] Opened Live Monitor in default browser (" + url + ").");
                }
            }
            catch (Exception ex)
            {
                AppendLog("[UI] Failed to open browser: " + ex.Message);
            }
        }

        private async void RunAdbReverseAsync()
        {
            btnAdbReverse.Enabled = false;
            try
            {
                string baseUrl = "http://127.0.0.1:" + this.serverPort;
                StringContent emptyBody = new StringContent("{}", Encoding.UTF8, "application/json");
                HttpResponseMessage resp = await this.http.PostAsync(baseUrl + "/api/system/adb-reverse", emptyBody);
                string bodyText = await resp.Content.ReadAsStringAsync();
                Dictionary<string, object> res = this.json.Deserialize<Dictionary<string, object>>(bodyText);
                bool ok = GetBool(res, "ok", false);
                string output = GetString(res, "output", bodyText);
                AppendLog("[ADB] " + output);
                ShowToast(ok ? ("ADB USB Reverse active (ws://127.0.0.1:" + this.serverPort + "/ws)!") : ("ADB Reverse failed: " + output), !ok);
            }
            catch (Exception ex)
            {
                AppendLog("[ADB] Error: " + ex.Message);
                ShowToast("ADB error: " + ex.Message, true);
            }
            finally
            {
                btnAdbReverse.Enabled = true;
            }
        }

        private void CopyToClipboard(string text, string toastMsg)
        {
            try
            {
                Clipboard.SetText(text);
                ShowToast(toastMsg, false);
            }
            catch (Exception ex)
            {
                ShowToast("Clipboard error: " + ex.Message, true);
            }
        }

        private void ShowToast(string message, bool isError)
        {
            if (this.IsDisposed) return;
            lblToast.ForeColor = isError ? ColOnErrorContainer : ColEmerald;
            lblToast.Text = message;
            toastTimer.Stop();
            toastTimer.Start();
        }

        private void AppendLog(string line)
        {
            if (this.IsDisposed) return;
            if (this.InvokeRequired)
            {
                try
                {
                    this.BeginInvoke((MethodInvoker)delegate { AppendLog(line); });
                }
                catch
                {
                }
                return;
            }

            string stamped = string.Format("[{0:HH:mm:ss}] {1}{2}", DateTime.Now, line.Trim(), Environment.NewLine);
            if (txtLogs.TextLength > 24000)
            {
                txtLogs.Text = txtLogs.Text.Substring(txtLogs.TextLength - 12000);
            }
            txtLogs.AppendText(stamped);
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!this.isExiting && e.CloseReason == CloseReason.UserClosing && swMinimizeToTray.Checked)
            {
                e.Cancel = true;
                this.Hide();
                trayIcon.ShowBalloonTip(2000, "PurrCam is still running", "Double-click the tray icon to reopen Control Center.", ToolTipIcon.Info);
                return;
            }

            this.isExiting = true;
            CleanupResources();
        }

        private void ShutdownAndExit()
        {
            this.isExiting = true;
            CleanupResources();
            Application.Exit();
        }

        private void CleanupResources()
        {
            try
            {
                if (pollTimer != null) pollTimer.Stop();
                if (trayIcon != null)
                {
                    trayIcon.Visible = false;
                    trayIcon.Dispose();
                }
            }
            catch
            {
            }

            if (!this.attachedToExistingServer && this.tunnelRunning)
            {
                try
                {
                    int port = this.serverPort;
                    Task.Run(async delegate
                    {
                        using (HttpClient fastHttp = new HttpClient())
                        {
                            fastHttp.Timeout = TimeSpan.FromMilliseconds(800);
                            StringContent content = new StringContent("{}", Encoding.UTF8, "application/json");
                            await fastHttp.PostAsync("http://127.0.0.1:" + port + "/api/remote/stop", content).ConfigureAwait(false);
                        }
                    }).Wait(900);
                }
                catch
                {
                }
            }

            if (this.nodeProcess != null)
            {
                try
                {
                    if (!this.nodeProcess.HasExited)
                    {
                        int pid = this.nodeProcess.Id;
                        try
                        {
                            ProcessStartInfo tk = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                            tk.CreateNoWindow = true;
                            tk.UseShellExecute = false;
                            using (Process p = Process.Start(tk))
                            {
                                p.WaitForExit(1500);
                            }
                        }
                        catch
                        {
                        }
                        if (!this.nodeProcess.HasExited)
                        {
                            this.nodeProcess.Kill();
                        }
                    }
                }
                catch
                {
                }
                this.nodeProcess = null;
            }

            if (this.jobHandle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(this.jobHandle);
                this.jobHandle = IntPtr.Zero;
            }
        }

        private static string FindNodeExecutable()
        {
            string onPath = FindOnPath("node.exe");
            if (!string.IsNullOrEmpty(onPath)) return onPath;

            string[] candidates = new string[]
            {
                BuildConfig.DefaultNodeExe,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };
            foreach (string c in candidates)
            {
                if (!string.IsNullOrWhiteSpace(c) && File.Exists(c)) return c;
            }
            return null;
        }

        private static string FindAppBrowser()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }

        private static string FindOnPath(string exeName)
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string full = Path.Combine(dir.Trim(), exeName);
                    if (File.Exists(full)) return full;
                }
                catch
                {
                }
            }
            return null;
        }

        private static string GetString(Dictionary<string, object> dict, string key, string fallback)
        {
            if (dict != null && dict.ContainsKey(key) && dict[key] != null)
            {
                return dict[key].ToString();
            }
            return fallback;
        }

        private static int GetInt(Dictionary<string, object> dict, string key, int fallback)
        {
            if (dict != null && dict.ContainsKey(key) && dict[key] != null)
            {
                int val;
                if (int.TryParse(dict[key].ToString(), out val)) return val;
            }
            return fallback;
        }

        private static bool GetBool(Dictionary<string, object> dict, string key, bool fallback)
        {
            if (dict != null && dict.ContainsKey(key) && dict[key] != null)
            {
                bool val;
                if (bool.TryParse(dict[key].ToString(), out val)) return val;
            }
            return fallback;
        }

        private static Dictionary<string, object> GetDict(Dictionary<string, object> dict, string key)
        {
            if (dict != null && dict.ContainsKey(key))
            {
                return dict[key] as Dictionary<string, object>;
            }
            return null;
        }

        internal static int ResolveConfiguredPort()
        {
            string rawPort = Environment.GetEnvironmentVariable("PORT");
            int parsed;
            if (!string.IsNullOrWhiteSpace(rawPort) && int.TryParse(rawPort.Trim(), out parsed) && parsed >= 1 && parsed <= 65535)
            {
                return parsed;
            }
            return 8787;
        }

        [STAThread]
        public static void Main(string[] args)
        {
            if (args != null && args.Length >= 2 && args[0] == "--generate-icon")
            {
                IconGenerator.GenerateMultiSizeCatEyeIcon(args[1]);
                return;
            }

            int port = ResolveConfiguredPort();
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\PurrCamDesktopControlCenterMutex_" + port, out createdNew))
            {
                NativeMethods.SetProcessDPIAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(args ?? new string[0]));
            }
        }
    }

    internal static class IconGenerator
    {
        public static void GenerateMultiSizeCatEyeIcon(string outputPath)
        {
            int[] sizes = new int[] { 16, 32, 48, 256 };
            List<byte[]> pngFrames = new List<byte[]>();

            foreach (int sz in sizes)
            {
                using (Bitmap bmp = RenderCatEyeBitmap(sz))
                using (MemoryStream ms = new MemoryStream())
                {
                    bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    pngFrames.Add(ms.ToArray());
                }
            }

            using (FileStream fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            using (BinaryWriter bw = new BinaryWriter(fs))
            {
                bw.Write((ushort)0);
                bw.Write((ushort)1);
                bw.Write((ushort)sizes.Length);

                int offset = 6 + (16 * sizes.Length);
                for (int i = 0; i < sizes.Length; i++)
                {
                    int sz = sizes[i];
                    byte dim = (byte)(sz >= 256 ? 0 : sz);
                    byte[] data = pngFrames[i];

                    bw.Write(dim);
                    bw.Write(dim);
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)32);
                    bw.Write((uint)data.Length);
                    bw.Write((uint)offset);
                    offset += data.Length;
                }

                for (int i = 0; i < pngFrames.Count; i++)
                {
                    bw.Write(pngFrames[i]);
                }
            }
        }

        private static Bitmap RenderCatEyeBitmap(int size)
        {
            Bitmap bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);

                float s = size;
                float pad = s * 0.04f;
                float radius = Math.Max(3f, s * 0.28f);
                RectangleF bgRect = new RectangleF(pad, pad, s - pad * 2f, s - pad * 2f);

                using (GraphicsPath bgPath = M3Geometry.CreateRoundedPath(bgRect, radius))
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(bgRect, Color.FromArgb(92, 64, 160), Color.FromArgb(40, 22, 82), 45f))
                {
                    g.FillPath(bgBrush, bgPath);
                }

                RectangleF iris = new RectangleF(s * 0.14f, s * 0.24f, s * 0.72f, s * 0.52f);
                using (LinearGradientBrush irisBrush = new LinearGradientBrush(iris, Color.FromArgb(252, 211, 77), Color.FromArgb(217, 119, 6), 45f))
                {
                    g.FillEllipse(irisBrush, iris);
                }

                RectangleF pupil = new RectangleF(s * 0.42f, s * 0.27f, s * 0.16f, s * 0.46f);
                using (SolidBrush pupilBrush = new SolidBrush(Color.FromArgb(20, 18, 24)))
                {
                    g.FillEllipse(pupilBrush, pupil);
                }

                RectangleF spec = new RectangleF(s * 0.53f, s * 0.30f, s * 0.11f, s * 0.11f);
                using (SolidBrush specBrush = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
                {
                    g.FillEllipse(specBrush, spec);
                }
            }
            return bmp;
        }
    }
}
