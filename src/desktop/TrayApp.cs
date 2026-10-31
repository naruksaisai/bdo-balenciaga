// BDO Balenciaga desktop UI (tray icon + main window).
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

namespace BdoBalenciaga
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
            Text = "BDO Balenciaga";
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
        private bool _lite;
        private List<string> _builtinEmojis;
        private int _maxLimit, _maxRoles;
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
                        _lastSettings = m;
                        if (_window != null) _window.ApplySettings(m, J.List(m, "warnings"), true);
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

            List<string> builtin = new List<string>();
            foreach (object o in J.List(m, "builtinEmojis")) builtin.Add(Convert.ToString(o, CultureInfo.InvariantCulture));

            _lite = J.Str(m, "edition") == "lite";
            _builtinEmojis = builtin;
            _maxLimit = J.Int(m, "maxLimit", 100);
            _maxRoles = J.Int(m, "maxRoles", 20);
            BuildTray();
            CreateWindow();

            string notice = J.Str(m, "notice");
            if (notice.Length > 0) _window.SetFeedback(notice, Feedback.Warning);

            Notify("ready", null);
            if (!J.Bool(m, "startMinimized")) ShowWindow();
        }

        private void CreateWindow()
        {
            _window = new MainWindow(this, _lite, _builtinEmojis, _maxLimit, _maxRoles, _icon);
            _window.VisibleChanged += delegate { OnWindowVisibility(); };
            if (_lastSettings != null) _window.ApplySettings(_lastSettings, null, false);
            if (_lastStatus != null) _window.ApplyStatus(_lastStatus);
            UpdateHostingControls();
        }

        // model: { values, roles, days }, the latest the window should show on Cancel.
        public void RememberSettings(Dictionary<string, object> model)
        {
            if (model != null) _lastSettings = model;
        }

        public Dictionary<string, object> LastSettings
        {
            get { return _lastSettings; }
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
            _tray.Text = "BDO Balenciaga";
            _tray.Icon = new Icon(_icon, SystemInformation.SmallIconSize);
            _tray.ContextMenuStrip = _menu;
            _tray.DoubleClick += delegate { ShowWindow(); };
            UpdateHostingControls();
        }

        public bool HostingEnabled
        {
            get { return _hostingEnabled; }
        }

        // The tray icon exists only while hosting is ON; with hosting OFF the
        // window is the app, and closing it quits.
        private void UpdateHostingControls()
        {
            bool canClick = _hostingCanToggle && !_hostingPending && !_exitRequested;
            if (_tray != null) _tray.Visible = _hostingEnabled && !_quitting;
            // Hosting is OFF (turned off from the tray, or a stale --minimized
            // launch) and the window is hidden: show it, or the app is invisible.
            if (_lastStatus != null && !_hostingEnabled && !_exitRequested && !_quitting &&
                _window != null && !_window.Visible) ShowWindow();
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
                _tray.ShowBalloonTip(5000, "BDO Balenciaga", text, icon);
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
            _tray.ShowBalloonTip(4000, "BDO Balenciaga",
                "Still running in the system tray. Hosting was not changed. Use Exit in the tray menu to quit.",
                ToolTipIcon.Info);
        }

        private void OnWindowVisibility()
        {
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["visible"] = _window.Visible;
            Notify("visibility", p);
        }

        public void RequestExit()
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
                "The BDO Balenciaga background process stopped unexpectedly, so hosting is not running on this PC.\r\n\r\n" +
                "Start BDO Balenciaga again to continue." +
                (_logPath.Length > 0 ? "\r\n\r\nDetails are in the log file:\r\n" + _logPath : ""),
                "BDO Balenciaga", MessageBoxButtons.OK, MessageBoxIcon.Error);
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

    // One line of the role table: a role, or the fixed Donkey (overflow) row,
    // which has no name box, no limit and cannot be removed.
    internal sealed class RoleRow
    {
        public string Key = "";      // empty for a role added in this window
        public Control NameCell;     // TextBox, or a label for Donkey
        public Control MaxCell;      // NumericUpDown, or a "no limit" label
        public TextBox Name;         // null for Donkey
        public NumericUpDown Max;    // null for Donkey
        public ComboBox Emoji;
        public Panel Preview;
        public Label PreviewText;
        public PictureBox PreviewImage;
        public Label Info;
        public Button Remove;        // null for Donkey
    }

    internal sealed class MainWindow : Form
    {
        private const string KeyTitle = "AUTO_EVENT_TITLE";
        private const string KeyDescription = "AUTO_EVENT_DESCRIPTION";
        private const string KeySchedule = "AUTO_EVENT_SCHEDULE";
        private const string KeyDonkey = "DONKEY_EMOJI";
        private const int NewRoleMax = 5;

        // Sunday first, like the user's calendar.
        private static readonly string[] DayKeys = new string[] { "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday" };
        private static readonly string[] DayLabels = new string[] { "Su", "Mo", "Tu", "We", "Th", "Fr", "Sa" };

        private static readonly Regex TimeRe = new Regex("^([01]?[0-9]|2[0-3]):[0-5][0-9]$");
        private static readonly Regex CustomEmojiRe = new Regex("^<(a?):([A-Za-z0-9_]{2,32}):([0-9]{17,20})>$");
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private readonly TrayApp _app;
        private readonly bool _lite;
        private readonly List<string> _builtinEmojis;
        private readonly int _maxLimit, _maxRoles;
        private readonly ErrorProvider _errors = new ErrorProvider();
        private readonly Dictionary<string, Control> _fieldControls = new Dictionary<string, Control>();
        private readonly Dictionary<string, CheckBox> _days = new Dictionary<string, CheckBox>();
        private readonly List<RoleRow> _roles = new List<RoleRow>();
        private RoleRow _donkey;
        private TableLayoutPanel _roleTable;
        private Label[] _roleHeaders;
        private Button _addRole;
        private Button _createNow;
        private Label _createHint;
        private bool _canCreateEvent, _posting;

        private Label _hostingValue, _roleValue, _roleExplain, _nextEvent, _hostingDetail, _notices;
        private Button _hostingButton;
        private Label _nodesCount, _nodesDetail, _nodesUpdated;
        private Button _refreshButton;
        private TextBox _title, _description, _schedule;
        private Label _feedback;
        private Button _save, _cancel, _exit;

        // Snapshot of the form as last loaded from Node; null until then.
        private string _loadedSnapshot;
        // Node sent newer settings while the user had unsaved edits.
        private bool _stale;
        private bool _applying, _saving;
        public bool AllowClose;

        // lite: hosting and active nodes only, no automatic event settings.
        public MainWindow(TrayApp app, bool lite, List<string> builtinEmojis, int maxLimit, int maxRoles, Icon icon)
        {
            _app = app;
            _lite = lite;
            _builtinEmojis = builtinEmojis;
            _maxLimit = maxLimit;
            _maxRoles = maxRoles;
            _errors.BlinkStyle = ErrorBlinkStyle.NeverBlink;

            Text = lite ? "BDO Balenciaga (Lite)" : "BDO Balenciaga";
            Icon = icon;
            Font = SystemFonts.MessageBoxFont;
            AutoScaleMode = AutoScaleMode.Font;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = lite ? new Size(600, 400) : new Size(780, 820);
            MinimumSize = lite ? new Size(520, 380) : new Size(640, 560);

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
            if (!lite) root.Controls.Add(BuildSettingsGroup(), 0, 2);
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
            // Colored badge so leader / standby is obvious at a glance.
            _roleValue = MakeLabel("OFF");
            _roleValue.Font = new Font(Font.FontFamily, 11f, FontStyle.Bold);
            _roleValue.ForeColor = Color.White;
            _roleValue.BackColor = Color.Gray;
            _roleValue.Padding = new Padding(8, 2, 8, 2);
            _roleExplain = MakeWrapLabel();
            _roleExplain.MaximumSize = new Size(470, 0);
            _nextEvent = MakeLabel("");
            _nextEvent.Font = new Font(Font, FontStyle.Bold);
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
            t.Controls.Add(_roleExplain, 1, 2);
            t.SetColumnSpan(_roleExplain, 2);
            t.Controls.Add(MakeLabel("Next event:"), 0, 3);
            t.Controls.Add(_nextEvent, 1, 3);
            t.SetColumnSpan(_nextEvent, 2);
            t.Controls.Add(_hostingDetail, 0, 4);
            t.SetColumnSpan(_hostingDetail, 3);
            t.Controls.Add(_notices, 0, 5);
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

        private Control BuildSettingsGroup()
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

            FlowLayoutPanel dayRow = new FlowLayoutPanel();
            dayRow.AutoSize = true;
            dayRow.WrapContents = false;
            dayRow.Margin = new Padding(0);
            for (int i = 0; i < DayKeys.Length; i++)
            {
                CheckBox cb = new CheckBox();
                cb.Text = DayLabels[i];
                cb.AutoSize = true;
                cb.Margin = new Padding(3, 5, 8, 3);
                cb.CheckedChanged += delegate { OnFieldChanged(); };
                _days[DayKeys[i]] = cb;
                dayRow.Controls.Add(cb);
            }
            Label dayHint = MakeLabel("an event is posted on each checked day");
            dayHint.ForeColor = SystemColors.GrayText;
            dayRow.Controls.Add(dayHint);

            outer.Controls.Add(MakeLabel("Event title"), 0, 0);
            outer.Controls.Add(_title, 1, 0);
            outer.Controls.Add(MakeLabel("Description"), 0, 1);
            outer.Controls.Add(_description, 1, 1);
            outer.Controls.Add(MakeLabel("Default time"), 0, 2);
            outer.Controls.Add(timeRow, 1, 2);
            outer.Controls.Add(MakeLabel("Event days"), 0, 3);
            outer.Controls.Add(dayRow, 1, 3);

            // Manual fallback for when the automatic event did not post.
            FlowLayoutPanel nowRow = new FlowLayoutPanel();
            nowRow.AutoSize = true;
            nowRow.WrapContents = false;
            nowRow.Margin = new Padding(0);
            _createNow = new Button();
            _createNow.Text = "Create event now";
            _createNow.AutoSize = true;
            _createNow.Enabled = false;
            _createNow.Click += delegate { CreateEventNow(); };
            _createHint = MakeLabel("");
            _createHint.ForeColor = SystemColors.GrayText;
            nowRow.Controls.Add(_createNow);
            nowRow.Controls.Add(_createHint);
            outer.Controls.Add(MakeLabel("Post now"), 0, 4);
            outer.Controls.Add(nowRow, 1, 4);

            Label note = MakeWrapLabel();
            note.ForeColor = SystemColors.GrayText;
            note.Text = "Uncheck a day to skip its event every week. A new default time or role max also updates any day of the " +
                        "per-day schedule still using the previous value; days customized with /raid-schedule keep their own. " +
                        "Events already posted are not changed.";
            outer.Controls.Add(note, 0, 5);
            outer.SetColumnSpan(note, 2);

            _roleTable = MakeTable(6);
            _roleTable.Margin = new Padding(0, 8, 0, 0);
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 56));
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _roleTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            string[] headers = new string[] { "Role", "Max players", "Emoji (pick, type or paste)", "Preview", "", "" };
            _roleHeaders = new Label[headers.Length];
            for (int i = 0; i < headers.Length; i++)
            {
                _roleHeaders[i] = MakeLabel(headers[i]);
                _roleHeaders[i].Font = new Font(Font, FontStyle.Bold);
            }
            _donkey = MakeRoleRow(true);
            _fieldControls[KeyDonkey] = _donkey.Emoji;
            RebuildRoleTable();
            outer.Controls.Add(_roleTable, 0, 6);
            outer.SetColumnSpan(_roleTable, 2);

            _addRole = new Button();
            _addRole.Text = "Add role";
            _addRole.AutoSize = true;
            _addRole.Margin = new Padding(3, 6, 3, 3);
            _addRole.Click += delegate { AddRole(); };
            outer.Controls.Add(_addRole, 0, 7);
            outer.SetColumnSpan(_addRole, 2);

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
            TableLayoutPanel t = MakeTable(4);
            t.Dock = DockStyle.Fill;
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            _feedback = MakeWrapLabel();
            _feedback.MaximumSize = new Size(_lite ? 460 : 380, 0);
            _feedback.UseMnemonic = false;
            t.Controls.Add(_feedback, 0, 0);
            _exit = new Button();
            _exit.Text = "Exit";
            _exit.AutoSize = true;
            _exit.MinimumSize = new Size(90, 30);
            _exit.Margin = new Padding(3, 3, _lite ? 3 : 16, 3);
            _exit.Click += delegate { ExitClicked(); };
            t.Controls.Add(_exit, 1, 0);
            if (_lite) return t;

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

            t.Controls.Add(_cancel, 2, 0);
            t.Controls.Add(_save, 3, 0);
            return t;
        }

        // ---- role table

        private RoleRow MakeRoleRow(bool donkey)
        {
            Padding errorRoom = new Padding(3, 3, 24, 3);
            RoleRow r = new RoleRow();
            if (donkey)
            {
                r.NameCell = MakeLabel("Donkey (overflow)");
                Label noLimit = MakeLabel("no limit");
                noLimit.ForeColor = SystemColors.GrayText;
                r.MaxCell = noLimit;
            }
            else
            {
                TextBox name = new TextBox();
                name.Width = 140;
                name.MaxLength = 32;
                name.Anchor = AnchorStyles.Left;
                name.Margin = errorRoom;
                name.TextChanged += delegate { OnFieldChanged(); };
                r.Name = name;
                r.NameCell = name;

                NumericUpDown n = new NumericUpDown();
                n.Minimum = 1;
                n.Maximum = _maxLimit;
                n.Width = 60;
                n.Anchor = AnchorStyles.Left;
                n.Margin = errorRoom;
                n.ValueChanged += delegate { OnFieldChanged(); };
                n.KeyUp += delegate { OnFieldChanged(); };
                r.Max = n;
                r.MaxCell = n;

                Button remove = new Button();
                remove.Text = "Remove";
                remove.AutoSize = true;
                remove.Anchor = AnchorStyles.Left;
                remove.Click += delegate { RemoveRole(r); };
                r.Remove = remove;
            }

            ComboBox c = new ComboBox();
            c.DropDownStyle = ComboBoxStyle.DropDown;
            c.Width = 170;
            c.MaxLength = 64;
            c.Anchor = AnchorStyles.Left;
            c.Font = new Font("Segoe UI Emoji", 10f);
            c.Margin = errorRoom;
            foreach (string e in _builtinEmojis) c.Items.Add(e);
            c.TextChanged += delegate { UpdatePreview(r); OnFieldChanged(); };
            r.Emoji = c;

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
            r.Preview = preview;
            r.PreviewText = pv;
            r.PreviewImage = pb;

            Label info = MakeLabel("");
            info.ForeColor = SystemColors.GrayText;
            info.UseMnemonic = false;
            r.Info = info;
            return r;
        }

        // Re-lays out the header, every role row and the Donkey row.
        private void RebuildRoleTable()
        {
            _roleTable.SuspendLayout();
            _roleTable.Controls.Clear();
            for (int i = 0; i < _roleHeaders.Length; i++) _roleTable.Controls.Add(_roleHeaders[i], i, 0);
            int row = 1;
            foreach (RoleRow r in _roles) AddRowCells(r, row++);
            AddRowCells(_donkey, row);
            _roleTable.RowCount = row + 1;
            _roleTable.ResumeLayout();
            UpdateRoleButtons();
        }

        private void AddRowCells(RoleRow r, int row)
        {
            _roleTable.Controls.Add(r.NameCell, 0, row);
            _roleTable.Controls.Add(r.MaxCell, 1, row);
            _roleTable.Controls.Add(r.Emoji, 2, row);
            _roleTable.Controls.Add(r.Preview, 3, row);
            if (r.Remove != null) _roleTable.Controls.Add(r.Remove, 4, row);
            _roleTable.Controls.Add(r.Info, 5, row);
        }

        private void DisposeRow(RoleRow r)
        {
            try { r.PreviewImage.CancelAsync(); } catch { }
            Control[] cells = new Control[] { r.NameCell, r.MaxCell, r.Emoji, r.Preview, r.Remove, r.Info };
            foreach (Control c in cells)
            {
                if (c == null) continue;
                _errors.SetError(c, "");
                c.Dispose();
            }
        }

        private void UpdateRoleButtons()
        {
            if (_addRole != null) _addRole.Enabled = _roles.Count < _maxRoles;
            foreach (RoleRow r in _roles) r.Remove.Enabled = _roles.Count > 1;
        }

        private void AddRole()
        {
            if (_roles.Count >= _maxRoles) return;
            RoleRow r = MakeRoleRow(false);
            r.Max.Value = Math.Min(NewRoleMax, _maxLimit);
            _roles.Add(r);
            RebuildRoleTable();
            UpdatePreview(r);
            r.Name.Focus();
            OnFieldChanged();
        }

        private void RemoveRole(RoleRow r)
        {
            if (_roles.Count <= 1 || !_roles.Remove(r)) return;
            RebuildRoleTable();
            DisposeRow(r);
            OnFieldChanged();
        }

        // ---- window behavior

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (AllowClose || e.CloseReason == CloseReason.WindowsShutDown) return;
            // Any other close (X button, Alt+F4, WM_CLOSE from outside): with
            // hosting OFF there is no tray icon, so it quits (Node exits cleanly
            // and sends "quit", which closes us with AllowClose). With hosting ON
            // it hides to the tray and hosting keeps running.
            e.Cancel = true;
            if (!_app.HostingEnabled)
            {
                _app.RequestExit();
                return;
            }
            Hide();
            _app.OnWindowHiddenToTray();
        }

        private void ExitClicked()
        {
            if (_app.HostingEnabled && MessageBox.Show(this,
                    "Exit stops hosting on this PC until you open the app again or sign in to Windows.\r\n\r\nExit now?",
                    "Exit BDO Balenciaga", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            _app.RequestExit();
        }

        private void CreateEventNow()
        {
            string text = "Post a new event card in the event channel now, using the saved settings?\r\n\r\n" +
                          "The card currently in the channel is removed. Today's automatic event still runs at its usual time.";
            if (IsDirty()) text += "\r\n\r\nYou have unsaved changes and they are not used. Save first to include them.";
            if (MessageBox.Show(this, text, "Create event now", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            _posting = true;
            _createNow.Enabled = false;
            SetFeedback("Posting the event...", Feedback.Info);
            _app.Request("createEventNow", null, delegate(Dictionary<string, object> resp)
            {
                _posting = false;
                _createNow.Enabled = _canCreateEvent;
                if (J.Bool(resp, "ok")) SetFeedback(J.Str(resp, "message"), Feedback.Success);
                else SetFeedback(J.Str(resp, "error"), Feedback.Error);
            });
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
            string roleLevel = J.Str(h, "roleLevel");
            _roleValue.Text = J.Str(h, "roleLabel").ToUpperInvariant();
            _roleValue.BackColor = roleLevel == "leader" ? Color.ForestGreen : roleLevel == "standby" ? Color.SteelBlue : Color.Gray;
            _roleExplain.Text = J.Str(h, "roleExplain");
            _nextEvent.Text = J.Str(h, "nextEvent");
            _nextEvent.ForeColor = roleLevel == "leader" ? SystemColors.ControlText : SystemColors.GrayText;
            _hostingDetail.Text = J.Str(h, "detail");
            _hostingDetail.ForeColor = level == "error" ? Color.Firebrick : SystemColors.ControlText;
            _canCreateEvent = J.Bool(h, "canCreateEvent");
            if (_createNow != null)
            {
                _createNow.Enabled = _canCreateEvent && !_posting;
                _createHint.Text = J.Str(h, "createEventHint");
            }

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

        // model: { values, roles, days } from Node. fromPush: Node sent it on its
        // own (another PC or /raid-schedule changed the schedule) - unsaved
        // edits are kept and the user is told instead.
        public void ApplySettings(Dictionary<string, object> model, List<object> warnings, bool fromPush)
        {
            if (_lite || model == null) return;
            Dictionary<string, object> values = J.Dict(model, "values");
            if (values == null) return;
            if (fromPush && _loadedSnapshot != null && (_saving || IsDirty()))
            {
                _stale = true;
                SetFeedback("The schedule was changed elsewhere (another PC or /raid-schedule). Click Cancel to load it, or Save to keep your changes.", Feedback.Warning);
                UpdateDirty();
                return;
            }

            List<RoleRow> old = new List<RoleRow>(_roles);
            _applying = true;
            try
            {
                _title.Text = J.Str(values, KeyTitle);
                _description.Text = J.Str(values, KeyDescription).Replace("\r\n", "\n").Replace("\n", "\r\n");
                _schedule.Text = J.Str(values, KeySchedule);
                _donkey.Emoji.Text = J.Str(values, KeyDonkey);
                _donkey.Emoji.SelectionLength = 0;
                Dictionary<string, object> days = J.Dict(model, "days");
                foreach (KeyValuePair<string, CheckBox> kv in _days) kv.Value.Checked = J.Bool(days, kv.Key);

                _roles.Clear();
                foreach (object o in J.List(model, "roles"))
                {
                    Dictionary<string, object> d = o as Dictionary<string, object>;
                    if (d == null) continue;
                    RoleRow r = MakeRoleRow(false);
                    r.Key = J.Str(d, "key");
                    r.Name.Text = J.Str(d, "label");
                    int v = J.Int(d, "max", 1);
                    r.Max.Value = Math.Max(r.Max.Minimum, Math.Min(r.Max.Maximum, v));
                    r.Emoji.Text = J.Str(d, "emoji");
                    r.Emoji.SelectionLength = 0;
                    _roles.Add(r);
                }
                RebuildRoleTable();
            }
            finally { _applying = false; }
            foreach (RoleRow r in old) DisposeRow(r);
            foreach (RoleRow r in _roles) UpdatePreview(r);
            UpdatePreview(_donkey);
            _errors.Clear();
            _stale = false;
            _loadedSnapshot = Snapshot();
            UpdateDirty();
            if (warnings != null && warnings.Count > 0)
            {
                List<string> w = new List<string>();
                foreach (object o in warnings) w.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
                SetFeedback(string.Join(" ", w.ToArray()), Feedback.Warning);
            }
        }

        // The saveSettings request body: { settings, roles, days }.
        private Dictionary<string, object> Collect()
        {
            Dictionary<string, object> s = new Dictionary<string, object>();
            s[KeyTitle] = _title.Text;
            s[KeyDescription] = _description.Text.Replace("\r\n", "\n");
            s[KeySchedule] = _schedule.Text.Trim();
            s[KeyDonkey] = _donkey.Emoji.Text.Trim();

            List<object> roles = new List<object>();
            foreach (RoleRow r in _roles)
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["key"] = r.Key;
                d["label"] = r.Name.Text.Trim();
                d["emoji"] = r.Emoji.Text.Trim();
                d["max"] = (int)r.Max.Value;
                roles.Add(d);
            }

            Dictionary<string, object> days = new Dictionary<string, object>();
            foreach (string day in DayKeys) days[day] = _days[day].Checked;

            Dictionary<string, object> p = new Dictionary<string, object>();
            p["settings"] = s;
            p["roles"] = roles;
            p["days"] = days;
            return p;
        }

        private string Snapshot()
        {
            return Json.Serialize(Collect());
        }

        private bool IsDirty()
        {
            return _loadedSnapshot != null && Snapshot() != _loadedSnapshot;
        }

        private void OnFieldChanged()
        {
            if (_applying) return;
            UpdateDirty();
        }

        private void UpdateDirty()
        {
            if (_lite) return;
            bool dirty = IsDirty();
            _save.Enabled = dirty && !_saving && _loadedSnapshot != null;
            _cancel.Enabled = (dirty || _stale) && !_saving;
        }

        private void UpdatePreview(RoleRow r)
        {
            string text = r.Emoji.Text.Trim();
            Label pv = r.PreviewText;
            PictureBox pb = r.PreviewImage;
            Label info = r.Info;
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

        // Error keys from Node: setting keys, or roles.<index>.<label|max|emoji>.
        private Control FieldControl(string key)
        {
            Control c;
            if (_fieldControls.TryGetValue(key, out c)) return c;
            string[] parts = key.Split('.');
            int i;
            if (parts.Length == 3 && parts[0] == "roles" &&
                int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out i) && i >= 0 && i < _roles.Count)
            {
                RoleRow r = _roles[i];
                if (parts[2] == "label") return r.Name;
                if (parts[2] == "max") return r.Max;
                if (parts[2] == "emoji") return r.Emoji;
            }
            return null;
        }

        private void Save()
        {
            _errors.Clear();
            bool bad = false;
            if (!TimeRe.IsMatch(_schedule.Text.Trim())) { _errors.SetError(_schedule, "Use 24-hour HH:MM, for example 21:30."); bad = true; }
            if (_title.Text.Trim().Length == 0) { _errors.SetError(_title, "Title is required."); bad = true; }
            foreach (RoleRow r in _roles)
            {
                if (r.Name.Text.Trim().Length == 0) { _errors.SetError(r.Name, "Enter a name."); bad = true; }
                if (r.Emoji.Text.Trim().Length == 0) { _errors.SetError(r.Emoji, "Choose an emoji."); bad = true; }
            }
            if (_donkey.Emoji.Text.Trim().Length == 0) { _errors.SetError(_donkey.Emoji, "Choose an emoji."); bad = true; }
            if (bad) { SetFeedback("Fix the highlighted fields, then save again.", Feedback.Error); return; }

            _saving = true;
            UpdateDirty();
            SetFeedback("Saving...", Feedback.Info);
            _app.Request("saveSettings", Collect(), delegate(Dictionary<string, object> resp)
            {
                _saving = false;
                if (J.Bool(resp, "ok"))
                {
                    ApplySettings(resp, null, false);
                    _app.RememberSettings(resp);
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
                            Control c = FieldControl(kv.Key);
                            if (c != null)
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
            Dictionary<string, object> latest = _app.LastSettings;
            if (latest == null) return;
            ApplySettings(latest, null, false);
            SetFeedback("Changes discarded.", Feedback.Info);
        }
    }
}
