// BDO Raid Helper desktop UI (tray icon + main window).
//
// Compiled at runtime by PowerShell 5.1 Add-Type (see uiProcess.js), which uses
// the .NET Framework C# 5 compiler: no string interpolation, no ?. operator, no
// expression-bodied members, no out var. Keep this file ASCII-only; any
// non-ASCII text (emoji, punctuation) arrives from Node as JSON.
//
// The UI owns no Discord credentials and no hosting logic. It renders what Node
// sends and forwards user actions as requests over stdin/stdout JSON lines.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace BdoRaidHelper
{
    public static class UiApp
    {
        public static int Run(Stream input, Stream output)
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            }
            catch { }
            // Discord's CDN (custom emoji previews) requires TLS 1.2.
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }

            Bridge bridge = new Bridge(input, output);
            TrayApp app = new TrayApp(bridge);
            return app.Run();
        }
    }

    // ---------------------------------------------------------------- transport

    internal sealed class Bridge
    {
        private readonly StreamReader _reader;
        private readonly StreamWriter _writer;
        private readonly object _writeLock = new object();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        // Raised on the reader thread; TrayApp marshals to the UI thread.
        public event Action<Dictionary<string, object>> MessageReceived;
        public event Action Closed;

        public Bridge(Stream input, Stream output)
        {
            _reader = new StreamReader(input, new UTF8Encoding(false));
            _writer = new StreamWriter(output, new UTF8Encoding(false));
            _writer.AutoFlush = true;
            _json.MaxJsonLength = 8 * 1024 * 1024;
        }

        public void Start()
        {
            Thread t = new Thread(ReadLoop);
            t.IsBackground = true;
            t.Name = "bdo-ipc-reader";
            t.Start();
        }

        private void ReadLoop()
        {
            try
            {
                string line;
                while ((line = _reader.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    Dictionary<string, object> msg = null;
                    try { msg = _json.DeserializeObject(line) as Dictionary<string, object>; }
                    catch { msg = null; }
                    Action<Dictionary<string, object>> h = MessageReceived;
                    if (msg != null && h != null) h(msg);
                }
            }
            catch { }
            Action c = Closed;
            if (c != null) c();
        }

        public bool Send(Dictionary<string, object> msg)
        {
            try
            {
                string text = _json.Serialize(msg);
                lock (_writeLock)
                {
                    _writer.Write(text);
                    _writer.Write('\n');
                }
                return true;
            }
            catch { return false; }
        }
    }

    internal static class J
    {
        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static bool Bool(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        public static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return fallback; }
        }

        public static Dictionary<string, object> Dict(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return null;
            return v as Dictionary<string, object>;
        }

        public static List<object> List(Dictionary<string, object> d, string key)
        {
            object v;
            List<object> result = new List<object>();
            if (d == null || !d.TryGetValue(key, out v) || v == null) return result;
            IEnumerable e = v as IEnumerable;
            if (e == null || v is string) return result;
            foreach (object o in e) result.Add(o);
            return result;
        }
    }

    internal sealed class PoolInfo
    {
        public string Key;
        public string Label;
        public string MaxKey;   // empty for the overflow pool
        public string EmojiKey;
    }

    internal enum Feedback { Info, Success, Warning, Error }

    // ------------------------------------------------------- shutdown listener

    // Top-level forms reliably receive WM_ENDSESSION (0x16) via WndProc, unlike
    // SystemEvents.SessionEnding which is unreliable under Fast Startup.
    // ShutdownBlockReasonCreate asks Windows for time while Node marks this host
    // offline in Discord.
    public class TrayForm : Form
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string pwszReason);
        [DllImport("user32.dll")]
        static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

        public event EventHandler EndSessionReceived;

        public TrayForm()
        {
            Text = "BDO Raid Helper";
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(1, 1);
            Location = new Point(-32000, -32000);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0016 /* WM_ENDSESSION */ && m.WParam != IntPtr.Zero)
            {
                try { ShutdownBlockReasonCreate(this.Handle, "Saving Discord state"); } catch { }
                try { EventHandler h = EndSessionReceived; if (h != null) h(this, EventArgs.Empty); } catch { }
                try { ShutdownBlockReasonDestroy(this.Handle); } catch { }
            }
            base.WndProc(ref m);
        }
    }

    // ------------------------------------------------------------ application

    internal sealed class TrayApp
    {
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);
        private const int SW_HIDE = 0, SW_SHOWNORMAL = 1;

        private readonly Bridge _bridge;
        private TrayForm _sink;
        private MainWindow _window;
        private NotifyIcon _tray;
        private ContextMenuStrip _menu;
        private ToolStripMenuItem _statusItem, _openItem, _hostingItem, _exitItem;
        private Icon _icon;
        private List<PoolInfo> _pools;
        private List<string> _builtinEmojis;
        private int _maxLimit;
        private Dictionary<string, object> _lastStatus, _lastSettings;

        private readonly Dictionary<int, Action<Dictionary<string, object>>> _pending =
            new Dictionary<int, Action<Dictionary<string, object>>>();
        private int _nextId = 1;
        private int _nodePid;
        private string _logPath = "";
        private bool _hostingEnabled, _hostingCanToggle, _hostingPending;
        private bool _exitRequested, _quitting, _quitDone, _endSession, _trayHintShown;

        public TrayApp(Bridge bridge) { _bridge = bridge; }

        public int Run()
        {
            Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e) { Log("error", "UI exception: " + e.Exception); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { Log("error", "Fatal UI exception: " + e.ExceptionObject); };

            _sink = new TrayForm();
            IntPtr sinkHandle = _sink.Handle; // BeginInvoke needs a handle before Application.Run
            // Windows applies the launcher's SW_HIDE (-WindowStyle Hidden) to the
            // first ShowWindow call of the process. Spend it on the invisible
            // shutdown listener so the main window can actually appear later.
            ShowWindow(sinkHandle, SW_HIDE);
            _sink.EndSessionReceived += OnEndSession;

            _bridge.MessageReceived += delegate(Dictionary<string, object> m)
            {
                try { _sink.BeginInvoke(new Action(delegate { Dispatch(m); })); } catch { }
            };
            _bridge.Closed += delegate
            {
                try { _sink.BeginInvoke(new Action(OnBackendClosed)); } catch { }
            };
            _bridge.Start();

            Application.Run(_sink);
            return 0;
        }

        // ---- protocol

        private void Dispatch(Dictionary<string, object> m)
        {
            try
            {
                switch (J.Str(m, "type"))
                {
                    case "init": OnInit(m); break;
                    case "status": OnStatus(J.Dict(m, "status")); break;
                    case "settings":
                        _lastSettings = J.Dict(m, "values");
                        if (_window != null) _window.ApplySettings(_lastSettings, J.List(m, "warnings"));
                        break;
                    case "response": OnResponse(m); break;
                    case "show": ShowWindow(); break;
                    case "quit": Quit(); break;
                }
            }
            catch (Exception ex)
            {
                Log("error", "Failed to handle " + J.Str(m, "type") + ": " + ex);
            }
        }

        public void Request(string type, Dictionary<string, object> payload, Action<Dictionary<string, object>> callback)
        {
            Dictionary<string, object> msg = payload ?? new Dictionary<string, object>();
            int id = _nextId++;
            msg["type"] = type;
            msg["id"] = id;
            if (callback != null) _pending[id] = callback;
            if (!_bridge.Send(msg))
            {
                _pending.Remove(id);
                if (callback != null) callback(ErrorResponse("Lost connection to the background process."));
            }
        }

        public void Notify(string type, Dictionary<string, object> payload)
        {
            Dictionary<string, object> msg = payload ?? new Dictionary<string, object>();
            msg["type"] = type;
            _bridge.Send(msg);
        }

        public void Log(string level, string message)
        {
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["level"] = level;
            p["message"] = message.Length > 1900 ? message.Substring(0, 1900) : message;
            Notify("log", p);
        }

        private static Dictionary<string, object> ErrorResponse(string error)
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = false;
            r["error"] = error;
            return r;
        }

        private void OnResponse(Dictionary<string, object> m)
        {
            int id = J.Int(m, "id", 0);
            Action<Dictionary<string, object>> cb;
            if (!_pending.TryGetValue(id, out cb)) return;
            _pending.Remove(id);
            cb(m);
        }

        private void OnInit(Dictionary<string, object> m)
        {
            if (_window != null) return;
            _nodePid = J.Int(m, "nodePid", 0);
            _logPath = J.Str(m, "logPath");

            string iconB64 = J.Str(m, "icon");
            if (iconB64.Length > 0)
            {
                try { _icon = new Icon(new MemoryStream(Convert.FromBase64String(iconB64))); } catch { _icon = null; }
            }
            if (_icon == null) _icon = SystemIcons.Application;

            List<PoolInfo> pools = new List<PoolInfo>();
            foreach (object o in J.List(m, "pools"))
            {
                Dictionary<string, object> d = o as Dictionary<string, object>;
                if (d == null) continue;
                PoolInfo p = new PoolInfo();
                p.Key = J.Str(d, "key"); p.Label = J.Str(d, "label");
                p.MaxKey = J.Str(d, "maxKey"); p.EmojiKey = J.Str(d, "emojiKey");
                pools.Add(p);
            }
            List<string> builtin = new List<string>();
            foreach (object o in J.List(m, "builtinEmojis")) builtin.Add(Convert.ToString(o, CultureInfo.InvariantCulture));

            _pools = pools;
            _builtinEmojis = builtin;
            _maxLimit = J.Int(m, "maxLimit", 100);
            BuildTray();
            CreateWindow();

            string notice = J.Str(m, "notice");
            if (notice.Length > 0) _window.SetFeedback(notice, Feedback.Warning);

            Notify("ready", null);
            if (!J.Bool(m, "startMinimized")) ShowWindow();
        }

        private void CreateWindow()
        {
            _window = new MainWindow(this, _pools, _builtinEmojis, _maxLimit, _icon);
            _window.VisibleChanged += delegate { OnWindowVisibility(); };
            if (_lastSettings != null) _window.ApplySettings(_lastSettings, null);
            if (_lastStatus != null) _window.ApplyStatus(_lastStatus);
            UpdateHostingControls();
        }

        public void RememberSettings(Dictionary<string, object> values)
        {
            if (values != null) _lastSettings = values;
        }

        private void OnStatus(Dictionary<string, object> st)
        {
            if (st == null) return;
            _lastStatus = st;
            Dictionary<string, object> h = J.Dict(st, "hosting");
            _hostingEnabled = J.Bool(h, "enabled");
            _hostingCanToggle = J.Bool(h, "canToggle");
            UpdateHostingControls();
            if (_statusItem != null) _statusItem.Text = J.Str(st, "menuStatus");
            if (_tray != null)
            {
                string tip = J.Str(st, "tooltip");
                _tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip; // NotifyIcon limit
            }
            if (_window != null) _window.ApplyStatus(st);
        }

        // ---- tray

        private void BuildTray()
        {
            _menu = new ContextMenuStrip();
            _statusItem = new ToolStripMenuItem("Starting...");
            _statusItem.Enabled = false;
            _openItem = new ToolStripMenuItem("Open");
            _openItem.Font = new Font(_openItem.Font, FontStyle.Bold);
            _openItem.Click += delegate { ShowWindow(); };
            _hostingItem = new ToolStripMenuItem("Hosting ON");
            _hostingItem.Click += delegate { ToggleHosting(); };
            _exitItem = new ToolStripMenuItem("Exit");
            _exitItem.Click += delegate { RequestExit(); };

            _menu.Items.Add(_statusItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_openItem);
            _menu.Items.Add(_hostingItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(_exitItem);

            _tray = new NotifyIcon();
            _tray.Text = "BDO Raid Helper";
            _tray.Icon = new Icon(_icon, SystemInformation.SmallIconSize);
            _tray.ContextMenuStrip = _menu;
            _tray.DoubleClick += delegate { ShowWindow(); };
            _tray.Visible = true;
            UpdateHostingControls();
        }

        private void UpdateHostingControls()
        {
            bool canClick = _hostingCanToggle && !_hostingPending && !_exitRequested;
            if (_hostingItem != null)
            {
                _hostingItem.Text = _hostingEnabled ? "Hosting ON (click to turn OFF)" : "Hosting OFF (click to turn ON)";
                _hostingItem.Checked = _hostingEnabled;
                _hostingItem.Enabled = canClick;
            }
            if (_window != null) _window.SetHostingControls(_hostingEnabled, canClick, _hostingPending);
        }

        // ---- actions

        public void ToggleHosting()
        {
            if (_hostingPending || _exitRequested) return;
            bool desired = !_hostingEnabled;
            _hostingPending = true;
            UpdateHostingControls();
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["enabled"] = desired;
            Request("setHosting", p, delegate(Dictionary<string, object> resp)
            {
                _hostingPending = false;
                UpdateHostingControls();
                if (J.Bool(resp, "ok"))
                {
                    string warn = string.Join(" ", J.List(resp, "warnings").ConvertAll<string>(delegate(object o) { return Convert.ToString(o, CultureInfo.InvariantCulture); }).ToArray());
                    string msg = J.Str(resp, "message");
                    if (warn.Length > 0) ReportResult(msg + " " + warn, Feedback.Warning);
                    else ReportResult(msg, Feedback.Success);
                }
                else ReportResult(J.Str(resp, "error"), Feedback.Error);
            });
        }

        public void RefreshNodes(Action done)
        {
            Request("refreshNodes", null, delegate(Dictionary<string, object> resp)
            {
                if (!J.Bool(resp, "ok")) ReportResult(J.Str(resp, "error"), Feedback.Error);
                if (done != null) done();
            });
        }

        // Shows the outcome in the window, or as a tray balloon if it is hidden.
        private void ReportResult(string text, Feedback kind)
        {
            if (text == null || text.Trim().Length == 0) return;
            if (_window != null && _window.Visible) { _window.SetFeedback(text, kind); return; }
            if (_tray != null)
            {
                ToolTipIcon icon = kind == Feedback.Error ? ToolTipIcon.Error : kind == Feedback.Warning ? ToolTipIcon.Warning : ToolTipIcon.Info;
                _tray.ShowBalloonTip(5000, "BDO Raid Helper", text, icon);
            }
        }

        public void ShowWindow()
        {
            if (_window == null || _quitting) return;
            if (_window.IsDisposed) CreateWindow(); // defensive: should never be closed for real
            if (!_window.Visible) _window.Show();
            if (!IsWindowVisible(_window.Handle)) ShowWindow(_window.Handle, SW_SHOWNORMAL);
            if (_window.WindowState == FormWindowState.Minimized) _window.WindowState = FormWindowState.Normal;
            // Toggling TopMost is the most reliable way to come forward when the
            // request originated from another process (second launch).
            _window.TopMost = true;
            _window.TopMost = false;
            _window.Activate();
            _window.BringToFront();
        }

        public void OnWindowHiddenToTray()
        {
            if (_trayHintShown || _tray == null) return;
            _trayHintShown = true;
            _tray.ShowBalloonTip(4000, "BDO Raid Helper",
                "Still running in the system tray. Hosting was not changed. Use Exit in the tray menu to quit.",
                ToolTipIcon.Info);
        }

        private void OnWindowVisibility()
        {
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["visible"] = _window.Visible;
            Notify("visibility", p);
        }

        private void RequestExit()
        {
            if (_exitRequested) return;
            _exitRequested = true;
            UpdateHostingControls();
            _exitItem.Enabled = false;
            if (_window != null && _window.Visible) _window.SetFeedback("Exiting...", Feedback.Info);
            Notify("exit", null);
            // Node normally answers with "quit" once hosting has stopped. If it
            // never does, close anyway so the UI cannot hang around.
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 15000;
            t.Tick += delegate { t.Stop(); Quit(); };
            t.Start();
        }

        private void Quit()
        {
            if (_quitDone) return;
            _quitDone = true;
            _quitting = true;
            try { if (_tray != null) { _tray.Visible = false; _tray.Dispose(); } } catch { }
            try { if (_menu != null) _menu.Dispose(); } catch { }
            if (_window != null) { _window.AllowClose = true; try { _window.Close(); } catch { } }
            try { _sink.Close(); } catch { }
        }

        private void OnBackendClosed()
        {
            foreach (Action<Dictionary<string, object>> cb in new List<Action<Dictionary<string, object>>>(_pending.Values))
            {
                try { cb(ErrorResponse("Lost connection to the background process.")); } catch { }
            }
            _pending.Clear();
            if (_quitting || _exitRequested || _endSession) { Quit(); return; }

            // Node died without asking us to quit: say so instead of leaving a
            // tray icon that controls nothing.
            _quitting = true;
            try { if (_tray != null) _tray.Visible = false; } catch { }
            MessageBox.Show(
                "The BDO Raid Helper background process stopped unexpectedly, so hosting is not running on this PC.\r\n\r\n" +
                "Start BDO Raid Helper again to continue." +
                (_logPath.Length > 0 ? "\r\n\r\nDetails are in the log file:\r\n" + _logPath : ""),
                "BDO Raid Helper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Quit();
        }

        private void OnEndSession(object sender, EventArgs e)
        {
            if (_endSession) return;
            _endSession = true;
            _quitting = true;
            Notify("endSession", null);
            // Block (up to 8 s) until Node has marked this host offline and exited.
            if (_nodePid > 0)
            {
                try { Process.GetProcessById(_nodePid).WaitForExit(8000); } catch { }
            }
        }
    }

    // ------------------------------------------------------------ main window

    internal sealed class MainWindow : Form
    {
        private const string KeyTitle = "AUTO_EVENT_TITLE";
        private const string KeyDescription = "AUTO_EVENT_DESCRIPTION";
        private const string KeySchedule = "AUTO_EVENT_SCHEDULE";

        private static readonly Regex TimeRe = new Regex("^([01]?[0-9]|2[0-3]):[0-5][0-9]$");
        private static readonly Regex CustomEmojiRe = new Regex("^<(a?):([A-Za-z0-9_]{2,32}):([0-9]{17,20})>$");

        private readonly TrayApp _app;
        private readonly List<PoolInfo> _pools;
        private readonly ErrorProvider _errors = new ErrorProvider();
        private readonly Dictionary<string, Control> _fieldControls = new Dictionary<string, Control>();
        private readonly Dictionary<string, NumericUpDown> _max = new Dictionary<string, NumericUpDown>();
        private readonly Dictionary<string, ComboBox> _emoji = new Dictionary<string, ComboBox>();
        private readonly Dictionary<string, Label> _emojiText = new Dictionary<string, Label>();
        private readonly Dictionary<string, PictureBox> _emojiImage = new Dictionary<string, PictureBox>();
        private readonly Dictionary<string, Label> _emojiInfo = new Dictionary<string, Label>();

        private Label _hostingValue, _roleValue, _hostingDetail, _notices;
        private Button _hostingButton;
        private Label _nodesCount, _nodesDetail, _nodesUpdated;
        private Button _refreshButton;
        private TextBox _title, _description, _schedule;
        private Label _feedback;
        private Button _save, _cancel;

        private Dictionary<string, object> _loaded;
        private bool _applying, _saving;
        public bool AllowClose;

        public MainWindow(TrayApp app, List<PoolInfo> pools, List<string> builtinEmojis, int maxLimit, Icon icon)
        {
            _app = app;
            _pools = pools;
            _errors.BlinkStyle = ErrorBlinkStyle.NeverBlink;

            Text = "BDO Raid Helper";
            Icon = icon;
            Font = SystemFonts.MessageBoxFont;
            AutoScaleMode = AutoScaleMode.Font;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(700, 760);
            MinimumSize = new Size(600, 560);

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.Padding = new Padding(10);
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(root);

            root.Controls.Add(BuildHostingGroup(), 0, 0);
            root.Controls.Add(BuildNodesGroup(), 0, 1);
            root.Controls.Add(BuildSettingsGroup(builtinEmojis, maxLimit), 0, 2);
            root.Controls.Add(BuildButtonRow(), 0, 3);

            FormClosing += OnFormClosing;
            UpdateDirty();
        }

        // ---- layout helpers

        private static Label MakeLabel(string text)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.Anchor = AnchorStyles.Left;
            l.Margin = new Padding(3, 6, 3, 3);
            return l;
        }

        private static Label MakeWrapLabel()
        {
            Label l = new Label();
            l.AutoSize = true;
            l.MaximumSize = new Size(640, 0);
            l.Margin = new Padding(3, 4, 3, 3);
            return l;
        }

        private static GroupBox MakeGroup(string title, Control content)
        {
            GroupBox g = new GroupBox();
            g.Text = title;
            g.Dock = DockStyle.Fill;
            g.AutoSize = true;
            g.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            g.Padding = new Padding(10, 6, 10, 8);
            g.Margin = new Padding(0, 0, 0, 8);
            content.Dock = DockStyle.Fill;
            g.Controls.Add(content);
            return g;
        }

        private static TableLayoutPanel MakeTable(int columns)
        {
            TableLayoutPanel t = new TableLayoutPanel();
            t.ColumnCount = columns;
            t.AutoSize = true;
            t.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            return t;
        }

        private Control BuildHostingGroup()
        {
            TableLayoutPanel t = MakeTable(3);
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _hostingValue = MakeLabel("...");
            _hostingValue.Font = new Font(Font.FontFamily, 11f, FontStyle.Bold);
            _roleValue = MakeLabel("...");
            _roleValue.Font = new Font(Font, FontStyle.Bold);
            _hostingButton = new Button();
            _hostingButton.Text = "Turn hosting ON";
            _hostingButton.AutoSize = true;
            _hostingButton.MinimumSize = new Size(170, 34);
            _hostingButton.Enabled = false;
            _hostingButton.Anchor = AnchorStyles.Right;
            _hostingButton.Click += delegate { _app.ToggleHosting(); };
            _hostingDetail = MakeWrapLabel();
            _notices = MakeWrapLabel();
            _notices.ForeColor = Color.DarkGoldenrod;

            t.Controls.Add(MakeLabel("Hosting:"), 0, 0);
            t.Controls.Add(_hostingValue, 1, 0);
            t.Controls.Add(_hostingButton, 2, 0);
            t.SetRowSpan(_hostingButton, 2);
            t.Controls.Add(MakeLabel("This PC's role:"), 0, 1);
            t.Controls.Add(_roleValue, 1, 1);
            t.Controls.Add(_hostingDetail, 0, 2);
            t.SetColumnSpan(_hostingDetail, 3);
            t.Controls.Add(_notices, 0, 3);
            t.SetColumnSpan(_notices, 3);
            return MakeGroup("Hosting", t);
        }

        private Control BuildNodesGroup()
        {
            TableLayoutPanel t = MakeTable(3);
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _nodesCount = new Label();
            _nodesCount.AutoSize = true;
            _nodesCount.Font = new Font(Font.FontFamily, 20f, FontStyle.Bold);
            _nodesCount.Text = "-";
            _nodesCount.Margin = new Padding(3, 0, 12, 0);
            _nodesCount.Anchor = AnchorStyles.Left;
            _nodesDetail = MakeWrapLabel();
            _nodesDetail.MaximumSize = new Size(480, 0);
            _nodesUpdated = MakeWrapLabel();
            _nodesUpdated.MaximumSize = new Size(480, 0);
            _nodesUpdated.ForeColor = SystemColors.GrayText;
            _refreshButton = new Button();
            _refreshButton.Text = "Refresh";
            _refreshButton.AutoSize = true;
            _refreshButton.Anchor = AnchorStyles.Right;
            _refreshButton.Click += delegate
            {
                _refreshButton.Enabled = false;
                _app.RefreshNodes(delegate { _refreshButton.Enabled = true; });
            };

            t.Controls.Add(_nodesCount, 0, 0);
            t.SetRowSpan(_nodesCount, 2);
            t.Controls.Add(_nodesDetail, 1, 0);
            t.Controls.Add(_nodesUpdated, 1, 1);
            t.Controls.Add(_refreshButton, 2, 0);
            t.SetRowSpan(_refreshButton, 2);
            return MakeGroup("Active nodes", t);
        }

        private Control BuildSettingsGroup(List<string> builtinEmojis, int maxLimit)
        {
            TableLayoutPanel outer = MakeTable(2);
            outer.Dock = DockStyle.Top;
            outer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            outer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            Padding errorRoom = new Padding(3, 3, 24, 3); // ErrorProvider icon sits to the right
            _title = new TextBox();
            _title.Margin = errorRoom;
            _title.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            _title.MaxLength = 256;
            _description = new TextBox();
            _description.Multiline = true;
            _description.ScrollBars = ScrollBars.Vertical;
            _description.Height = 64;
            _description.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            _description.Margin = errorRoom;
            _description.MaxLength = 4000;
            _schedule = new TextBox();
            _schedule.Width = 70;
            _schedule.MaxLength = 5;
            _schedule.Margin = errorRoom;

            FlowLayoutPanel timeRow = new FlowLayoutPanel();
            timeRow.AutoSize = true;
            timeRow.WrapContents = false;
            timeRow.Margin = new Padding(0);
            timeRow.Controls.Add(_schedule);
            Label timeHint = MakeLabel("24-hour HH:MM, this PC's local time");
            timeHint.ForeColor = SystemColors.GrayText;
            timeRow.Controls.Add(timeHint);

            outer.Controls.Add(MakeLabel("Event title"), 0, 0);
            outer.Controls.Add(_title, 1, 0);
            outer.Controls.Add(MakeLabel("Description"), 0, 1);
            outer.Controls.Add(_description, 1, 1);
            outer.Controls.Add(MakeLabel("Default time"), 0, 2);
            outer.Controls.Add(timeRow, 1, 2);

            Label note = MakeWrapLabel();
            note.ForeColor = SystemColors.GrayText;
            note.Text = "The default time and pool limits also update any day of the per-day schedule that still uses the previous default. " +
                        "Days customized with /raid-schedule keep their own values. Events already posted are not changed.";
            outer.Controls.Add(note, 0, 3);
            outer.SetColumnSpan(note, 2);

            TableLayoutPanel pt = MakeTable(5);
            pt.Margin = new Padding(0, 8, 0, 0);
            pt.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            pt.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            pt.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            pt.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));
            pt.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            string[] headers = new string[] { "Pool", "Max players", "Emoji (pick, type or paste)", "Preview", "" };
            for (int i = 0; i < headers.Length; i++)
            {
                Label h = MakeLabel(headers[i]);
                h.Font = new Font(Font, FontStyle.Bold);
                pt.Controls.Add(h, i, 0);
            }

            int row = 1;
            foreach (PoolInfo pool in _pools)
            {
                PoolInfo p = pool;
                pt.Controls.Add(MakeLabel(p.Label), 0, row);

                if (p.MaxKey.Length > 0)
                {
                    NumericUpDown n = new NumericUpDown();
                    n.Minimum = 1;
                    n.Maximum = maxLimit;
                    n.Width = 70;
                    n.Anchor = AnchorStyles.Left;
                    n.Margin = errorRoom;
                    n.ValueChanged += delegate { OnFieldChanged(); };
                    n.KeyUp += delegate { OnFieldChanged(); };
                    _max[p.MaxKey] = n;
                    _fieldControls[p.MaxKey] = n;
                    pt.Controls.Add(n, 1, row);
                }
                else
                {
                    Label overflow = MakeLabel("no limit");
                    overflow.ForeColor = SystemColors.GrayText;
                    pt.Controls.Add(overflow, 1, row);
                }

                ComboBox c = new ComboBox();
                c.DropDownStyle = ComboBoxStyle.DropDown;
                c.Width = 200;
                c.MaxLength = 64;
                c.Anchor = AnchorStyles.Left;
                c.Font = new Font("Segoe UI Emoji", 10f);
                c.Margin = errorRoom;
                foreach (string e in builtinEmojis) c.Items.Add(e);
                c.TextChanged += delegate { UpdatePreview(p); OnFieldChanged(); };
                _emoji[p.EmojiKey] = c;
                _fieldControls[p.EmojiKey] = c;
                pt.Controls.Add(c, 2, row);

                Panel preview = new Panel();
                preview.Size = new Size(46, 34);
                preview.Margin = new Padding(3, 1, 3, 1);
                Label pv = new Label();
                pv.Dock = DockStyle.Fill;
                pv.TextAlign = ContentAlignment.MiddleCenter;
                pv.Font = new Font("Segoe UI Emoji", 15f);
                pv.UseMnemonic = false;
                PictureBox pb = new PictureBox();
                pb.Size = new Size(30, 30);
                pb.Location = new Point(8, 2);
                pb.SizeMode = PictureBoxSizeMode.Zoom;
                pb.Visible = false;
                preview.Controls.Add(pb);
                preview.Controls.Add(pv);
                _emojiText[p.EmojiKey] = pv;
                _emojiImage[p.EmojiKey] = pb;
                pt.Controls.Add(preview, 3, row);

                Label info = MakeLabel("");
                info.ForeColor = SystemColors.GrayText;
                info.UseMnemonic = false;
                _emojiInfo[p.EmojiKey] = info;
                pt.Controls.Add(info, 4, row);
                row++;
            }
            outer.Controls.Add(pt, 0, 4);
            outer.SetColumnSpan(pt, 2);

            _fieldControls[KeyTitle] = _title;
            _fieldControls[KeyDescription] = _description;
            _fieldControls[KeySchedule] = _schedule;
            _title.TextChanged += delegate { OnFieldChanged(); };
            _description.TextChanged += delegate { OnFieldChanged(); };
            _schedule.TextChanged += delegate { OnFieldChanged(); };

            Panel scroller = new Panel();
            scroller.AutoScroll = true;
            scroller.Controls.Add(outer);

            GroupBox g = new GroupBox();
            g.Text = "Automatic event";
            g.Dock = DockStyle.Fill;
            g.Padding = new Padding(10, 6, 10, 8);
            g.Margin = new Padding(0, 0, 0, 8);
            scroller.Dock = DockStyle.Fill;
            g.Controls.Add(scroller);
            return g;
        }

        private Control BuildButtonRow()
        {
            TableLayoutPanel t = MakeTable(3);
            t.Dock = DockStyle.Fill;
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _feedback = MakeWrapLabel();
            _feedback.MaximumSize = new Size(470, 0);
            _feedback.UseMnemonic = false;
            _cancel = new Button();
            _cancel.Text = "Cancel";
            _cancel.AutoSize = true;
            _cancel.MinimumSize = new Size(90, 30);
            _cancel.Click += delegate { CancelEdits(); };
            _save = new Button();
            _save.Text = "Save";
            _save.AutoSize = true;
            _save.MinimumSize = new Size(90, 30);
            _save.Click += delegate { Save(); };

            t.Controls.Add(_feedback, 0, 0);
            t.Controls.Add(_cancel, 1, 0);
            t.Controls.Add(_save, 2, 0);
            return t;
        }

        // ---- window behavior

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (AllowClose || e.CloseReason == CloseReason.WindowsShutDown) return;
            // Any other close (X button, Alt+F4, WM_CLOSE from outside) hides to
            // the tray; hosting keeps whatever state it had.
            e.Cancel = true;
            Hide();
            _app.OnWindowHiddenToTray();
        }

        // ---- status

        public void SetHostingControls(bool enabled, bool canClick, bool pending)
        {
            _hostingButton.Text = pending ? "Working..." : enabled ? "Turn hosting OFF" : "Turn hosting ON";
            _hostingButton.Enabled = canClick;
        }

        public void ApplyStatus(Dictionary<string, object> st)
        {
            Dictionary<string, object> h = J.Dict(st, "hosting");
            bool enabled = J.Bool(h, "enabled");
            string level = J.Str(h, "level");
            _hostingValue.Text = J.Str(h, "label");
            _hostingValue.ForeColor = enabled ? Color.ForestGreen : SystemColors.GrayText;
            _roleValue.Text = J.Str(h, "roleLabel");
            _hostingDetail.Text = J.Str(h, "detail");
            _hostingDetail.ForeColor = level == "error" ? Color.Firebrick : SystemColors.ControlText;

            List<string> notes = new List<string>();
            foreach (object o in J.List(st, "notices")) notes.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
            _notices.Text = string.Join("\r\n", notes.ToArray());
            _notices.Visible = notes.Count > 0;

            Dictionary<string, object> n = J.Dict(st, "nodes");
            string nl = J.Str(n, "level");
            Color c = nl == "unavailable" ? Color.Firebrick : nl == "stale" ? Color.DarkOrange : nl == "loading" ? SystemColors.GrayText : SystemColors.ControlText;
            _nodesCount.Text = J.Str(n, "count");
            _nodesCount.ForeColor = c;
            _nodesDetail.Text = J.Str(n, "detail");
            _nodesDetail.ForeColor = c;
            _nodesUpdated.Text = J.Str(n, "updated");
        }

        public void SetFeedback(string text, Feedback kind)
        {
            _feedback.Text = text ?? "";
            _feedback.ForeColor =
                kind == Feedback.Error ? Color.Firebrick :
                kind == Feedback.Warning ? Color.DarkOrange :
                kind == Feedback.Success ? Color.ForestGreen : SystemColors.ControlText;
        }

        // ---- settings

        public void ApplySettings(Dictionary<string, object> values, List<object> warnings)
        {
            if (values == null) return;
            _loaded = values;
            _applying = true;
            try
            {
                _title.Text = J.Str(values, KeyTitle);
                _description.Text = J.Str(values, KeyDescription).Replace("\r\n", "\n").Replace("\n", "\r\n");
                _schedule.Text = J.Str(values, KeySchedule);
                foreach (KeyValuePair<string, NumericUpDown> kv in _max)
                {
                    int v = J.Int(values, kv.Key, 1);
                    kv.Value.Value = Math.Max(kv.Value.Minimum, Math.Min(kv.Value.Maximum, v));
                }
                foreach (KeyValuePair<string, ComboBox> kv in _emoji)
                {
                    kv.Value.Text = J.Str(values, kv.Key);
                    kv.Value.SelectionLength = 0;
                }
            }
            finally { _applying = false; }
            foreach (PoolInfo p in _pools) UpdatePreview(p);
            _errors.Clear();
            UpdateDirty();
            if (warnings != null && warnings.Count > 0)
            {
                List<string> w = new List<string>();
                foreach (object o in warnings) w.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
                SetFeedback(string.Join(" ", w.ToArray()), Feedback.Warning);
            }
        }

        private Dictionary<string, object> Collect()
        {
            Dictionary<string, object> v = new Dictionary<string, object>();
            v[KeyTitle] = _title.Text;
            v[KeyDescription] = _description.Text.Replace("\r\n", "\n");
            v[KeySchedule] = _schedule.Text.Trim();
            foreach (KeyValuePair<string, NumericUpDown> kv in _max) v[kv.Key] = (int)kv.Value.Value;
            foreach (KeyValuePair<string, ComboBox> kv in _emoji) v[kv.Key] = kv.Value.Text.Trim();
            return v;
        }

        private bool IsDirty()
        {
            if (_loaded == null) return false;
            Dictionary<string, object> cur = Collect();
            foreach (KeyValuePair<string, object> kv in cur)
            {
                string a = Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
                string b = J.Str(_loaded, kv.Key);
                if (a != b) return true;
            }
            return false;
        }

        private void OnFieldChanged()
        {
            if (_applying) return;
            UpdateDirty();
        }

        private void UpdateDirty()
        {
            bool dirty = IsDirty();
            _save.Enabled = dirty && !_saving && _loaded != null;
            _cancel.Enabled = dirty && !_saving;
        }

        private void UpdatePreview(PoolInfo p)
        {
            string text = _emoji[p.EmojiKey].Text.Trim();
            Label pv = _emojiText[p.EmojiKey];
            PictureBox pb = _emojiImage[p.EmojiKey];
            Label info = _emojiInfo[p.EmojiKey];
            Match m = CustomEmojiRe.Match(text);
            try { pb.CancelAsync(); } catch { }

            if (m.Success)
            {
                pv.Text = "";
                pb.Image = null;
                pb.Visible = true;
                string ext = m.Groups[1].Value == "a" ? "gif" : "png";
                try { pb.LoadAsync("https://cdn.discordapp.com/emojis/" + m.Groups[3].Value + "." + ext + "?size=48"); } catch { }
                info.Text = "Discord custom emoji :" + m.Groups[2].Value + ":";
                info.ForeColor = SystemColors.GrayText;
            }
            else if (text.Length == 0)
            {
                pv.Text = "";
                pb.Visible = false;
                info.Text = "Required";
                info.ForeColor = Color.Firebrick;
            }
            else if (LooksLikeEmoji(text))
            {
                pv.Text = text;
                pb.Visible = false;
                info.Text = "Unicode emoji";
                info.ForeColor = SystemColors.GrayText;
            }
            else
            {
                pv.Text = "";
                pb.Visible = false;
                info.Text = "Not an emoji - use a Unicode emoji or <:name:id>";
                info.ForeColor = Color.Firebrick;
            }
        }

        // Quick client-side hint only; Node performs the authoritative check.
        private static bool LooksLikeEmoji(string s)
        {
            if (s.Length > 32) return false;
            bool pictograph = false;
            foreach (char c in s)
            {
                if (char.IsWhiteSpace(c)) return false;
                if (c < 0x80 && !(c == '#' || c == '*' || (c >= '0' && c <= '9'))) return false;
                if (c >= 0x2000) pictograph = true;
            }
            return pictograph;
        }

        private void Save()
        {
            _errors.Clear();
            bool bad = false;
            if (!TimeRe.IsMatch(_schedule.Text.Trim())) { _errors.SetError(_schedule, "Use 24-hour HH:MM, for example 21:30."); bad = true; }
            if (_title.Text.Trim().Length == 0) { _errors.SetError(_title, "Title is required."); bad = true; }
            foreach (KeyValuePair<string, ComboBox> kv in _emoji)
            {
                if (kv.Value.Text.Trim().Length == 0) { _errors.SetError(kv.Value, "Choose an emoji."); bad = true; }
            }
            if (bad) { SetFeedback("Fix the highlighted fields, then save again.", Feedback.Error); return; }

            _saving = true;
            UpdateDirty();
            SetFeedback("Saving...", Feedback.Info);
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["settings"] = Collect();
            _app.Request("saveSettings", payload, delegate(Dictionary<string, object> resp)
            {
                _saving = false;
                if (J.Bool(resp, "ok"))
                {
                    ApplySettings(J.Dict(resp, "values"), null);
                    _app.RememberSettings(J.Dict(resp, "values"));
                    List<object> warnings = J.List(resp, "warnings");
                    string msg = J.Str(resp, "message");
                    if (warnings.Count > 0)
                    {
                        List<string> w = new List<string>();
                        foreach (object o in warnings) w.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
                        SetFeedback(msg + " " + string.Join(" ", w.ToArray()), Feedback.Warning);
                    }
                    else SetFeedback(msg, Feedback.Success);
                }
                else
                {
                    Dictionary<string, object> fe = J.Dict(resp, "fieldErrors");
                    int shown = 0;
                    if (fe != null)
                    {
                        foreach (KeyValuePair<string, object> kv in fe)
                        {
                            Control c;
                            if (_fieldControls.TryGetValue(kv.Key, out c))
                            {
                                _errors.SetError(c, Convert.ToString(kv.Value, CultureInfo.InvariantCulture));
                                shown++;
                            }
                        }
                    }
                    string err = J.Str(resp, "error");
                    SetFeedback(err.Length > 0 ? err : shown > 0 ? "Fix the highlighted fields, then save again." : "Settings were not saved.", Feedback.Error);
                }
                UpdateDirty();
            });
        }

        private void CancelEdits()
        {
            if (_loaded == null) return;
            ApplySettings(_loaded, null);
            SetFeedback("Changes discarded.", Feedback.Info);
        }
    }
}
