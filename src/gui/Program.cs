using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DouyinDownloader
{
    // 抖音任务
    class Job
    {
        public ListViewItem Row;
        public string Url = "";
        public bool Finished = false;
        public bool Failed = false;
        public long Bytes = 0;
        public int FileCount = 0;
        public string Quality = "";
        public string Title = "";
    }

    // 音乐条目
    class MusicTrack
    {
        public string Platform = "";
        public string PlatformName = "";
        public string Title = "";
        public string Artist = "";
        public string Album = "";
        public string Duration = "";
        public bool Ok = false;
        public string Url = "";
        public string Referer = "";
        public string Ext = "mp3";
        public long Size = 0;
        public bool Best = false;
        public string Error = "";
        // 引擎按格式/码率筛掉的标记（UI 必须显示，否则用户以为过滤没生效）
        public bool Filtered = false;
        public string FilterReason = "";
        // 试听相关
        public string PreviewUrl = "";
        public string PreviewExt = "";
        public long PreviewSize = 0;
        public double PreviewDur = 0;
        public ListViewItem Row;
    }

    // 站点视频任务
    class SiteJob
    {
        public ListViewItem Row;
        public string Url = "";
        public string Title = "";
        public string Quality = "";
        public int FileCount = 0;
        public long Bytes = 0;
        public bool Finished = false;
        public bool Failed = false;
    }

    // 知乎任务
    class ZhihuJob
    {
        public ListViewItem Row;
        public string Url = "";
        public string Title = "";
        public int Chars = 0;
        public int Images = 0;
        public string Dest = "";
        public bool Finished = false;
        public bool Failed = false;
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            // .NET Framework 默认不一定启用 TLS 1.2/1.3，HttpClient 会报「发送请求时出错」
            try
            {
                System.Net.ServicePointManager.SecurityProtocol =
                    (System.Net.SecurityProtocolType)3072 |      // Tls12
                    (System.Net.SecurityProtocolType)12288 |     // Tls13
                    (System.Net.SecurityProtocolType)768 |       // Tls11
                    (System.Net.SecurityProtocolType)192;        // Tls
            }
            catch
            {
                try { System.Net.ServicePointManager.SecurityProtocol = (System.Net.SecurityProtocolType)3072; }
                catch { }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // ── 内置自检模式 ──
            // 外部自动化工具跨进程操作 WinForms 控件非常脆（多行 TextBox 没有
            // ValuePattern，WM_SETTEXT 又要跨进程共享内存，进程直接崩）。
            // 与其在进程外折腾，不如让程序自己走一遍：填字段 → 点按钮 →
            // 采样进度 → 写结果文件。这也是可长期复用的回归测试入口。
            //
            //   下载器UI.exe --selftest zhihu <url> <输出文件>
            //   下载器UI.exe --selftest video <url> <输出文件>
            //   下载器UI.exe --selftest music <关键词> <输出文件>
            string[] args = Environment.GetCommandLineArgs();
            if (args.Length >= 3 && args[1] == "--selftest")
            {
                string kind = args[2];
                string payload = args.Length > 3 ? args[3] : "";
                string resultFile = args.Length > 4 ? args[4] : null;
                bool quiet = false;
                foreach (string a in args) if (a == "--quiet") quiet = true;
                Application.Run(new MainForm(new SelfTestSpec
                {
                    Kind = kind,
                    Payload = payload,
                    ResultFile = resultFile,
                    Quiet = quiet,
                }));
                return;
            }

            // ── 静默启动：--no-activate ──
            // 让窗口从出现的第一刻起就不抢焦点（ShowWithoutActivation）。
            // 用于「要开始测试但我在用别的窗口」的场景。
            bool noActivate = false;
            foreach (string a in args) if (a == "--no-activate") noActivate = true;
            if (noActivate)
            {
                Application.Run(new MainForm { NoActivateOnShow = true });
                return;
            }

            Application.Run(new MainForm());
        }
    }

    /// <summary>内置自检的参数</summary>
    class SelfTestSpec
    {
        public string Kind = "";
        public string Payload = "";
        public string ResultFile = null;
        /// <summary>静默模式：窗口不激活、不弹模态框，直接跑完退出</summary>
        public bool Quiet = false;
    }

    class MainForm : Form
    {
        // ───── 抖音 ─────
        TextBox txtLinks, txtOut;
        ComboBox cmbQuality;
        CheckBox chkAudio, chkHeadful;
        Button btnStart, btnStop, btnBrowse, btnOpenDir, btnClear;
        ListView listTasks;

        // ───── 音乐 ─────
        TextBox txtMusicKey, txtMusicOut;
        NumericUpDown numLimit;
        Button btnMusicSearch, btnMusicBest, btnMusicDownload, btnMusicBrowse, btnMusicOpen, btnMusicPreview;
        CheckBox chkFmtMp3, chkFmtM4a, chkFmtFlac;
        ComboBox cmbMinKbps;
        ListView listMusic;
        readonly List<MusicTrack> tracks = new List<MusicTrack>();
        Process musicProc = null;
        System.Windows.Forms.Timer musicWatch = null;
        DateTime musicSearchAt = DateTime.MinValue;

        // ───── 站点视频（B站/优酷/腾讯等）─────
        TextBox txtSiteUrl, txtSiteOut;
        ComboBox cmbSiteQuality;
        CheckBox chkSiteSubs, chkSiteAllParts;
        TextBox txtSiteCookieBrowser;
        Button btnSiteStart, btnSiteStop, btnSiteBrowse, btnSiteOpen;
        ListView listSites;
        readonly List<SiteJob> siteJobs = new List<SiteJob>();
        Process siteProc = null;
        System.Windows.Forms.Timer siteWatch = null;
        DateTime siteStartAt = DateTime.MinValue;

        // ───── 网页抓取 ─────
        TextBox txtGrabUrl, txtGrabOut;
        CheckBox chkGrabText, chkGrabImages, chkGrabLinks;
        NumericUpDown numGrabLimit;
        Button btnGrabStart, btnGrabBrowse, btnGrabOpen;
        RichTextBox txtGrabResult;
        Process grabProc = null;
        int grabResultLen = 0;

        // ───── 知乎 ─────
        TextBox txtZhihuUrl, txtZhihuOut;
        Button btnZhihuStart, btnZhihuStop, btnZhihuBrowse, btnZhihuOpen;
        CheckBox chkZhihuHeadful, chkZhihuClip, chkFmtMd, chkFmtTxt, chkFmtDocx;
        ListView listZhihu;
        readonly List<ZhihuJob> zhihuJobs = new List<ZhihuJob>();
        Process zhihuProc = null;
        // 抓取进度：进度条不再"两跳定格"，靠计时器推进 + 静默检测
        System.Windows.Forms.Timer zhihuWatch = null;
        DateTime zhihuStartAt = DateTime.MinValue;
        DateTime zhihuLastOutput = DateTime.MinValue;
        int zhihuStage = 10;      // 10 启动 → 20 引擎起 → 30 浏览器 → 50 抓到 → 90 汇总
        int zhihuDone = 0;
        int zhihuExpect = 0;

        // ───── 公共 ─────
        TabControl tabs;
        TabPage tabVideo, tabMusic, tabZhihu, tabSites, tabGrab;
        TabPage tabWechat, tabPlaylist, tabStock;
        Panel topVideo, topMusic, topZhihu, topSites, topGrab, bottom;
        Panel topWechat, topPlaylist, topStock;
        ProgressBar progress;
        RichTextBox txtLog;
        StatusStrip statusBar;
        ToolStripStatusLabel statusLabel;

        // ───── 公众号（v1.1.0）─────
        TextBox txtWxUrl, txtWxOut;
        Button btnWxBrowse, btnWxOpen, btnWxStart;
        CheckBox chkWxNoImages, chkWxDocx;

        // ───── 歌单（v1.1.0）─────
        TextBox txtPlUrl, txtPlOut;
        NumericUpDown numPlLimit;
        Button btnPlBrowse, btnPlOpen, btnPlStart;
        CheckBox chkPlMeta;

        // ───── 素材（v1.1.0）─────
        TextBox txtStKeyword, txtStOut;
        ComboBox cmbStScene, cmbStSource;
        NumericUpDown numStLimit;
        Button btnStBrowse, btnStOpen, btnStStart;
        CheckBox chkStLandscape;

        Process engine = null;
        Thread reader = null;
        volatile bool stopping = false;
        Job current = null;
        readonly List<Job> jobs = new List<Job>();

        // ═══════════════════════ 免责声明 / 首次同意 ═══════════════════════
        // 目的：把「用户已阅读并同意」变成可举证的记录。
        // 首次启动强制弹窗，必须勾选才能继续；同意后写入带时间戳的标记文件，
        // 之后启动不再打扰。协议正文随包分发（免责声明.md），
        // 程序里内置一份摘要，避免用户删了 md 就看不到。
        // ── 版本号 ──
        // 以前在各处硬编码 "v1.0.1"，每换一个版本要改 6 处，漏一处就会在
        // 标题栏 / 关于框里露出旧版本号。
        // 值来自构建脚本生成的 _version.gen.cs（AppBuild 静态类）。
        // csc 的 /define 只接受标识符、塞不进字符串，所以用"生成一个源文件"的方式注入。
        /// <summary>开源免费版：不校验授权、不显示激活状态。</summary>
        const bool FreeEdition = true;

        const string AppVersion = AppBuild.Version;
        const string AppVersionBeta = AppBuild.VersionBeta;

        const string EULA_VERSION = "v1.0.1";

        static string EulaMarkPath()
        {
            return Path.Combine(Application.StartupPath, ".eula-agreed");
        }

        static bool EulaAgreed()
        {
            try
            {
                string p = EulaMarkPath();
                if (!File.Exists(p)) return false;
                string txt = File.ReadAllText(p, Encoding.UTF8);
                // 版本变了要重新同意（改了条款就得让用户重新确认）
                return txt.Contains("version=" + EULA_VERSION);
            }
            catch { return false; }
        }

        static void WriteEulaMark()
        {
            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("version=" + EULA_VERSION);
                sb.AppendLine("agreed_at=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("machine=" + Environment.MachineName);
                sb.AppendLine("user=" + Environment.UserName);
                File.WriteAllText(EulaMarkPath(), sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }

        // ── 内测版提示（只在 INTERNAL_BUILD 里生效，每台机器只弹一次） ──
        static string BetaMarkPath()
        {
            return Path.Combine(Application.StartupPath, ".beta-notice-shown");
        }

        /// <summary>
        /// 内测版第一次启动时弹一次说明，告诉测试者三件事：
        ///   1. 这版无需激活，但只给内测用
        ///   2. 出问题点「帮助 → 反馈问题」，日志会自动脱敏上报
        ///   3. 别外传
        /// 只弹一次（写标记文件），避免每次启动都骚扰。
        /// </summary>
        void ShowBetaNoticeOnce()
        {
#if INTERNAL_BUILD
            try
            {
                string mark = BetaMarkPath();
                if (File.Exists(mark)) return;
                File.WriteAllText(mark,
                    "shown_at=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\n" +
                    "machine=" + Environment.MachineName + "\n",
                    Encoding.UTF8);
            }
            catch { }

            MsgBox(
                "这是内测版（v" + AppVersionBeta + "），无需激活，五个功能全部可用（小说走命令行）。\n\n" +
                "【请帮忙做三件事】\n\n" +
                "1. 每个标签页都点一遍，看能不能正常下载\n" +
                "2. 遇到报错或卡住，点菜单「帮助 → 反馈问题」，\n" +
                "   勾上「附带日志」，发给我\n" +
                "3. 留意哪里不好用、哪里文案看不懂，一并告诉我\n\n" +
                "【说明】\n" +
                "· 这是测试版，可能有不稳定的地方\n" +
                "· 请勿外传，正式版发布后会通知你\n" +
                "· 包内「常见问题.md」有 62 条自查，先看看能省很多时间\n\n" +
                "谢谢帮忙测试。",
                "内测版说明"
            );
#endif
        }

        // ═══════════════════════ 激活 / 授权 ═══════════════════════
        MenuStrip menuBar;
        ToolStripMenuItem miLicense;
        ToolStripMenuItem miMachine;
        ToolStripMenuItem miActivate;
        ToolStripMenuItem miStatus;
        ToolStripMenuItem miAbout;

        void BuildMenu()
        {
            menuBar = new MenuStrip();
            menuBar.BackColor = Color.White;

            // 开源免费版：菜单从「授权」改成「帮助」，不再有激活入口
            miLicense = new ToolStripMenuItem("帮助(&H)");
            miMachine = new ToolStripMenuItem("查看本机机器码…");
            miActivate = new ToolStripMenuItem("输入激活码…");
            miStatus = new ToolStripMenuItem("查看激活状态…");
            miAbout = new ToolStripMenuItem("关于");
            var miFeedback = new ToolStripMenuItem("反馈问题…");
            var miDonate = new ToolStripMenuItem("支持作者（打赏）…");

            miFeedback.Click += delegate { ShowFeedback(); };
            miMachine.Click += delegate { ShowMachineCode(); };
            miActivate.Click += delegate { DoActivate(); };
            miStatus.Click += delegate { ShowLicenseStatus(); };
            miAbout.Click += delegate { ShowAbout(); };
            miDonate.Click += delegate { ShowDonate(); };

            // 打赏放在最上面 —— 这是开源项目唯一的收入来源，
            // 藏在二级菜单里没人会点。
            miLicense.DropDownItems.AddRange(new ToolStripItem[] {
                miDonate, new ToolStripSeparator(),
                miFeedback, miAbout, new ToolStripSeparator(),
                miMachine, miStatus
            });
            menuBar.Items.Add(miLicense);
            MainMenuStrip = menuBar;
            Controls.Add(menuBar);
        }

        /// <summary>调引擎拿机器码</summary>
        string EngineRun(string args)
        {
            try
            {
                bool u;
                string eng = FindEngine("下载器.exe", out u);
                if (eng == null) return null;
                var psi = new ProcessStartInfo(eng, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.WorkingDirectory = Application.StartupPath;
                using (var p = Process.Start(psi))
                {
                    // stderr 也重定向了就必须读掉，否则子进程写满 4KB 管道
                    // 缓冲区后会永久阻塞，而我们还卡在 stdout.ReadToEnd 上。
                    string err = "";
                    Thread er = new Thread(delegate () { try { err = p.StandardError.ReadToEnd(); } catch { } });
                    er.IsBackground = true;
                    er.Start();

                    string o = p.StandardOutput.ReadToEnd();

                    // 旧版忽略了 WaitForExit 的返回值：超时后进程还在跑，
                    // 而 using 只会 Dispose（不 Kill），残留进程会一直占着引擎。
                    if (!p.WaitForExit(20000))
                    {
                        try { p.Kill(); } catch { }
                        return o.Length > 0 ? o : null;
                    }
                    try { er.Join(1000); } catch { }
                    return o;
                }
            }
            catch { return null; }
        }

        /// <summary>把激活状态显示到标题栏和状态栏</summary>
        void UpdateLicenseUi()
        {
            try
            {
#if INTERNAL_BUILD
                // 内部版不需要激活，标题和状态栏直接说明
                Text = "统一下载器 " + InternalVersion + InternalTag;
                statusLabel.Text = "内测版  ·  无需激活  ·  有问题请点「帮助 → 反馈问题」";
#else
                // 开源免费版：不再显示激活状态（没有这个概念了）。
                // 保留 licenseOk 分支的代码结构，方便 fork 做收费版时改回来。
                if (FreeEdition)
                {
                    Text = "统一下载器 " + AppVersion + InternalTag;
                    statusLabel.Text = "免费开源  ·  全部功能可用  ·  喜欢的话请点「帮助 → 支持作者」";
                }
                else if (licenseOk)
                {
                    Text = "统一下载器 " + AppVersion + InternalTag + "  ·  已激活";
                    var sb2 = new StringBuilder();
                    sb2.Append("已激活");
                    if (licenseTier.Length > 0) sb2.Append("  ·  " + licenseTier);
                    if (licenseDaysLeft >= 0) sb2.Append("  ·  剩 " + licenseDaysLeft + " 天");
                    sb2.Append("  ·  机器码 " + licenseMachine);
                    statusLabel.Text = sb2.ToString();
                }
                else
                {
                    Text = "统一下载器 " + AppVersion + InternalTag + "  ·  未激活";
                    statusLabel.Text = "未激活  ·  机器码 " + licenseMachine;
                }
#endif
            }
            catch { }
        }

        void ShowMachineCode()
        {
            string o = EngineRun("license machine");
            string mc = "";
            if (o != null)
            {
                foreach (string line in o.Split('\n'))
                {
                    int i = line.IndexOf("机器码:");
                    if (i >= 0) { mc = line.Substring(i + 4).Trim(); break; }
                }
            }
            if (mc.Length == 0) { MsgBox("读取机器码失败，请确认引擎存在", "错误"); return; }

            using (var dlg = new Form())
            {
                dlg.Text = "本机机器码";
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false; dlg.MinimizeBox = false;
                dlg.ClientSize = new Size(460, 210);
                dlg.Font = new Font("Microsoft YaHei UI", 9F);
                dlg.BackColor = Color.White;

                var lbl = new Label();
                lbl.Text = "把这个机器码发给卖家，换取绑定本机的激活码：";
                lbl.Location = new Point(18, 16);
                lbl.AutoSize = true;
                lbl.ForeColor = Color.FromArgb(80, 80, 90);

                var box = new TextBox();
                box.Text = mc;
                box.Location = new Point(18, 44);
                box.Size = new Size(420, 34);
                box.Font = new Font("Consolas", 15F, FontStyle.Bold);
                box.ReadOnly = true;
                box.TextAlign = HorizontalAlignment.Center;
                box.BackColor = Color.FromArgb(245, 245, 250);

                var btnCopy = new Button();
                btnCopy.Text = "复制";
                btnCopy.Location = new Point(18, 92);
                btnCopy.Size = new Size(100, 32);
                btnCopy.Click += delegate
                {
                    try { Clipboard.SetText(mc); btnCopy.Text = "已复制 ✓"; }
                    catch { MsgBox("复制失败，请手动选中", "提示"); }
                };

                var note = new Label();
                note.Text = "机器码由 hostname + CPU 型号生成，换机器会变；\n加内存、换硬盘不影响。";
                note.Location = new Point(18, 136);
                note.AutoSize = true;
                note.ForeColor = Color.FromArgb(130, 130, 140);

                var btnOk = new Button();
                btnOk.Text = "关闭";
                btnOk.Location = new Point(340, 128);
                btnOk.Size = new Size(96, 32);
                btnOk.DialogResult = DialogResult.OK;

                dlg.Controls.AddRange(new Control[] { lbl, box, btnCopy, note, btnOk });
                dlg.AcceptButton = btnOk;
                dlg.ShowDialog(this);
            }
        }

        void DoActivate()
        {
            using (var dlg = new Form())
            {
                dlg.Text = "输入激活码";
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false; dlg.MinimizeBox = false;
                dlg.ClientSize = new Size(560, 260);
                dlg.Font = new Font("Microsoft YaHei UI", 9F);
                dlg.BackColor = Color.White;

                var lbl = new Label();
                lbl.Text = "粘贴卖家给你的激活码（整串，含字母数字）：";
                lbl.Location = new Point(18, 16);
                lbl.AutoSize = true;

                var box = new TextBox();
                box.Multiline = true;
                box.ScrollBars = ScrollBars.Vertical;
                box.Location = new Point(18, 42);
                box.Size = new Size(524, 110);
                box.Font = new Font("Consolas", 8.5F);
                box.BorderStyle = BorderStyle.FixedSingle;

                var tip = new Label();
                tip.Text = "激活码与机器绑定，只能在本机使用。";
                tip.Location = new Point(18, 160);
                tip.AutoSize = true;
                tip.ForeColor = Color.FromArgb(130, 130, 140);

                var btnOk = new Button();
                btnOk.Text = "激活";
                btnOk.Location = new Point(330, 186);
                btnOk.Size = new Size(100, 34);
                btnOk.BackColor = Color.FromArgb(0, 120, 212);
                btnOk.ForeColor = Color.White;
                btnOk.FlatStyle = FlatStyle.Flat;
                btnOk.FlatAppearance.BorderSize = 0;
                btnOk.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);

                var btnCancel = new Button();
                btnCancel.Text = "取消";
                btnCancel.Location = new Point(442, 186);
                btnCancel.Size = new Size(100, 34);
                btnCancel.DialogResult = DialogResult.Cancel;
                btnCancel.FlatStyle = FlatStyle.Flat;

                string pending = null;
                btnOk.Click += delegate
                {
                    string code = box.Text.Trim();
                    if (code.Length == 0) { MsgBox("请先粘贴激活码", "提示"); return; }
                    string o = EngineRun("license activate \"" + code.Replace("\"", "") + "\"");
                    lastActivateOut = o;
                    if (o != null && o.Contains("激活成功"))
                    {
                        pending = "ok";
                        dlg.Close();
                    }
                    else
                    {
                        string why = "未知原因";
                        if (o != null)
                        {
                            int i = o.IndexOf("激活失败:");
                            if (i >= 0) why = o.Substring(i + 5).Trim().Split('\n')[0].Trim();
                        }
                        Log("[激活] 失败: " + why);
                        MsgBox("激活失败：\n" + why, "错误");
                    }
                };

                dlg.Controls.AddRange(new Control[] { lbl, box, tip, btnOk, btnCancel });
                dlg.AcceptButton = btnOk;
                dlg.CancelButton = btnCancel;
                dlg.ShowDialog(this);

                if (pending == "ok")
                {
                    Log("━━━ 激活成功 ━━━");
                    RefreshLicense(true);
                    UpdateLicenseUi();

                    // 续费累加时把「加了多少」明确告诉用户，
                    // 否则他只知道"激活成功"，不知道天数有没有叠上去。
                    string extra = "";
                    if (lastActivateOut != null)
                    {
                        foreach (string ln in lastActivateOut.Split('\n'))
                        {
                            string t = ln.Trim();
                            if (t.StartsWith("📈") || t.StartsWith("⚠"))
                            {
                                extra = "\n\n" + t;
                                Log(t);
                                break;
                            }
                        }
                    }
                    MsgBox("激活成功。" + extra + "\n\n现在可以使用全部功能。", "激活");
                }
            }
        }

        /// <summary>打赏窗口：显示微信收款码。</summary>
        void ShowDonate()
        {
            var dlg = new Form();
            dlg.Text = "支持作者";
            dlg.StartPosition = FormStartPosition.CenterParent;
            dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
            dlg.MaximizeBox = false;
            dlg.MinimizeBox = false;
            dlg.BackColor = Color.White;
            dlg.ClientSize = new Size(420, 640);

            var tip = new Label();
            tip.Text = "本软件完全免费开源，不收取任何费用。\n" +
                       "如果它帮到了你，可以请作者喝杯咖啡 ☕";
            tip.Location = new Point(20, 14);
            tip.Size = new Size(380, 46);
            tip.ForeColor = Color.FromArgb(70, 70, 80);
            tip.Font = new Font("Microsoft YaHei UI", 9F);
            dlg.Controls.Add(tip);

            // 收款码图片随程序打包（嵌入资源），不依赖外部文件
            PictureBox pic = null;
            try
            {
                var asm = System.Reflection.Assembly.GetExecutingAssembly();
                Stream st = null;
                foreach (string nm in asm.GetManifestResourceNames())
                {
                    if (nm.EndsWith("donate.png", StringComparison.OrdinalIgnoreCase))
                    { st = asm.GetManifestResourceStream(nm); break; }
                }
                if (st != null)
                {
                    using (st)
                    {
                        pic = new PictureBox();
                        pic.Image = Image.FromStream(st);
                        pic.SizeMode = PictureBoxSizeMode.Zoom;
                        pic.Location = new Point(30, 66);
                        pic.Size = new Size(360, 482);
                        pic.BackColor = Color.White;
                        dlg.Controls.Add(pic);
                    }
                }
            }
            catch { }

            if (pic == null)
            {
                var miss = new Label();
                miss.Text = "（收款码图片未随程序打包）";
                miss.Location = new Point(30, 300);
                miss.AutoSize = true;
                miss.ForeColor = Color.Gray;
                dlg.Controls.Add(miss);
            }

            var foot = new Label();
            foot.Text = "微信扫码 · 金额随意 · 不打赏也完全不影响使用";
            foot.Location = new Point(20, 558);
            foot.Size = new Size(380, 22);
            foot.TextAlign = ContentAlignment.MiddleCenter;
            foot.ForeColor = Color.FromArgb(130, 130, 140);
            foot.Font = new Font("Microsoft YaHei UI", 8.5F);
            dlg.Controls.Add(foot);

            var btn = new Button();
            btn.Text = "关闭";
            btn.Location = new Point(160, 590);
            btn.Size = new Size(100, 30);
            btn.Click += delegate { dlg.Close(); };
            dlg.Controls.Add(btn);

            dlg.ShowDialog(this);
        }

        void ShowLicenseStatus()
        {
            string o = EngineRun("license status");
            if (o == null) { MsgBox("读取状态失败", "错误"); return; }
            var sb = new StringBuilder();
            foreach (string line in o.Split('\n'))
            {
                string t = line.Trim();
                if (t.Length == 0) continue;
                sb.AppendLine(t);
            }
            MsgBox(sb.ToString().Trim(), "激活状态");
        }

        /// <summary>
        /// 自动上报（后台线程，不阻塞 UI）。
        /// 触发时机：引擎以非 0 退出码结束，或启动失败。
        /// 每台机器每天最多 3 次，由 report.mjs 自己限流。
        /// </summary>
        void AutoReport(string kind, string message, string detail)
        {
            if (selfTest != null) return;   // 自检不打扰开发者邮箱
            try
            {
                var th = new Thread(delegate ()
                {
                    try
                    {
                        string logDir = Path.Combine(Application.StartupPath, "logs");
                        string logFile = Path.Combine(logDir, "ui-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                        string args = "report " + Quote("[" + kind + "] " + message);
                        if (File.Exists(logFile)) args += " --log " + Quote(logFile);
                        string o = EngineRun(args);
                        if (o != null && o.Contains("已发送"))
                        {
                            try { BeginInvoke((MethodInvoker)delegate { Log("[自动上报] 已发送错误报告"); }); } catch { }
                        }
                    }
                    catch { }
                });
                th.IsBackground = true;
                th.Start();
            }
            catch { }
        }

        /// <summary>反馈问题：描述 + 可选附带日志，脱敏后发到开发者邮箱</summary>
        void ShowFeedback()
        {
            using (var dlg = new Form())
            {
                dlg.Text = "反馈问题";
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false; dlg.MinimizeBox = false;
                dlg.ClientSize = new Size(560, 340);
                dlg.Font = new Font("Microsoft YaHei UI", 9F);
                dlg.BackColor = Color.White;

                var lbl = new Label();
                lbl.Text = "描述一下遇到的问题（越具体越好）：";
                lbl.Location = new Point(18, 14);
                lbl.AutoSize = true;

                var box = new TextBox();
                box.Multiline = true;
                box.ScrollBars = ScrollBars.Vertical;
                box.Location = new Point(18, 40);
                box.Size = new Size(524, 120);
                box.BorderStyle = BorderStyle.FixedSingle;

                var chkLog = new CheckBox();
                chkLog.Text = "附带最近的运行日志（自动脱敏：路径/邮箱/卡密都会抹掉）";
                chkLog.Location = new Point(18, 170);
                chkLog.AutoSize = true;
                chkLog.Checked = true;

                var tip = new Label();
                tip.Text = "报告会发送到开发者邮箱。发送失败不影响软件使用。";
                tip.Location = new Point(18, 196);
                tip.AutoSize = true;
                tip.ForeColor = Color.FromArgb(130, 130, 140);

                var btnSend = new Button();
                btnSend.Text = "发送";
                btnSend.Location = new Point(330, 230);
                btnSend.Size = new Size(100, 34);
                btnSend.BackColor = Color.FromArgb(0, 120, 212);
                btnSend.ForeColor = Color.White;
                btnSend.FlatStyle = FlatStyle.Flat;
                btnSend.FlatAppearance.BorderSize = 0;
                btnSend.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);

                var btnCancel = new Button();
                btnCancel.Text = "取消";
                btnCancel.Location = new Point(442, 230);
                btnCancel.Size = new Size(100, 34);
                btnCancel.DialogResult = DialogResult.Cancel;
                btnCancel.FlatStyle = FlatStyle.Flat;

                btnSend.Click += delegate
                {
                    string desc = box.Text.Trim();
                    if (desc.Length < 4)
                    {
                        MsgBox("请至少写几个字描述问题", "提示");
                        return;
                    }

                    string args = "report " + Quote(desc);
                    if (chkLog.Checked)
                    {
                        string logDir = Path.Combine(Application.StartupPath, "logs");
                        string logFile = Path.Combine(logDir, "ui-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                        if (File.Exists(logFile)) args += " --log " + Quote(logFile);
                    }

                    string o = EngineRun(args);
                    bool ok = o != null && o.Contains("已发送");
                    Log("[反馈] " + (ok ? "已发送" : "未发送"));
                    MsgBox(ok
                        ? "已发送，感谢反馈！"
                        : "未发送成功。可能是本版本未配置上报邮箱，或网络问题。\n\n你仍可通过其他渠道联系卖家。",
                        ok ? "完成" : "提示");
                    if (ok) dlg.Close();
                };

                dlg.Controls.AddRange(new Control[] { lbl, box, chkLog, tip, btnSend, btnCancel });
                dlg.AcceptButton = btnSend;
                dlg.CancelButton = btnCancel;
                dlg.ShowDialog(this);
            }
        }

        void ShowAbout()
        {
            MsgBox(
                "统一下载器 " + AppVersion + "\n\n" +
                "抖音 · 音乐三平台 · 站点视频 · 网页抓取 · 知乎转 Markdown\n\n" +
                "依赖: Chrome/Edge（抖音/知乎）、yt-dlp（站点）、ffmpeg（合并）\n" +
                "FFmpeg 为 GPLv3，详见随包免责声明.md\n\n" +
                "本软件仅供个人学习与合法备份使用。",
                "关于");
        }

        /// <summary>首次启动的同意窗口。返回 true 表示用户同意。</summary>
        bool ShowEulaDialog()
        {
            using (var dlg = new Form())
            {
                dlg.Text = "使用前请阅读并同意";
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.MaximizeBox = false;
                dlg.MinimizeBox = false;
                dlg.ClientSize = new Size(640, 560);
                dlg.Font = new Font("Microsoft YaHei UI", 9F);
                dlg.BackColor = Color.White;

                var title = new Label();
                title.Text = "免责声明与用户协议";
                title.Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold);
                title.Location = new Point(18, 14);
                title.AutoSize = true;

                var sub = new Label();
                sub.Text = "首次使用需阅读并同意以下条款（完整版见程序目录 免责声明.md）";
                sub.ForeColor = Color.FromArgb(110, 110, 120);
                sub.Location = new Point(20, 42);
                sub.AutoSize = true;

                var box = new RichTextBox();
                box.Location = new Point(20, 66);
                box.Size = new Size(600, 380);
                box.ReadOnly = true;
                box.BorderStyle = BorderStyle.FixedSingle;
                box.BackColor = Color.FromArgb(250, 250, 252);
                box.Font = new Font("Microsoft YaHei UI", 9F);
                box.Text =
                    "【软件性质】\n" +
                    "本软件是通用技术工具，仅提供网络请求与本地保存能力。不提供、不托管、不分发任何第三方内容，\n" +
                    "不内置任何账号、会员资格或破解密钥，不提供绕过付费墙、DRM 或会员校验的能力。\n\n" +
                    "【禁止行为】使用者承诺不将本软件用于：\n" +
                    "  1. 下载、传播依法禁止的内容；\n" +
                    "  2. 下载未获授权的影视剧、付费课程、会员专享内容并二次分发或商业利用；\n" +
                    "  3. 规避任何平台的付费机制、会员校验、数字版权管理（DRM）；\n" +
                    "  4. 批量抓取、刷量、流量造假；\n" +
                    "  5. 移除水印、权利人标识、版权声明；\n" +
                    "  6. 其他任何违法行为。\n\n" +
                    "【用户责任】\n" +
                    "使用者应自行判断使用行为是否合法，自行取得权利人授权或确认属于合理使用，\n" +
                    "并自行承担全部后果。下载第三方内容不等于获得任何授权。\n\n" +
                    "【无担保与责任限制】\n" +
                    "本软件按「现状」提供，不附带任何担保。在适用法律允许的最大范围内，\n" +
                    "开发者不对间接损失、利润损失、第三方索赔承担责任；\n" +
                    "累计赔偿责任上限为使用者实际支付的金额（免费提供则为 0 元）。\n\n" +
                    "【用户赔偿】\n" +
                    "使用者违反上述禁止行为导致开发者被第三方主张权利、被行政调查或被平台追责的，\n" +
                    "应全额赔偿开发者因此产生的全部损失（含赔偿金、律师费、诉讼费）。\n\n" +
                    "【隐私】\n" +
                    "本软件不收集、不上传任何个人信息与下载记录。运行日志仅存本地。\n\n" +
                    "【特别提示】\n" +
                    "本软件仅用于个人学习、研究与合法备份。点击「同意」即表示你已阅读、理解并接受上述全部条款。\n" +
                    "如不同意，请点击「不同意」退出并删除本软件。\n";

                var chk = new CheckBox();
                chk.Text = "我已阅读并同意上述条款，且承诺不将本软件用于侵权或违法用途";
                chk.Location = new Point(20, 456);
                chk.AutoSize = true;

                var btnAgree = new Button();
                btnAgree.Text = "同意并继续";
                btnAgree.Location = new Point(400, 490);
                btnAgree.Size = new Size(120, 34);
                btnAgree.BackColor = Color.FromArgb(0, 120, 212);
                btnAgree.ForeColor = Color.White;
                btnAgree.FlatStyle = FlatStyle.Flat;
                btnAgree.FlatAppearance.BorderSize = 0;
                btnAgree.Enabled = false;
                btnAgree.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);

                var btnQuit = new Button();
                btnQuit.Text = "不同意，退出";
                btnQuit.Location = new Point(530, 490);
                btnQuit.Size = new Size(96, 34);
                btnQuit.FlatStyle = FlatStyle.Flat;

                var openDoc = new LinkLabel();
                openDoc.Text = "查看完整协议";
                openDoc.Location = new Point(20, 500);
                openDoc.AutoSize = true;
                openDoc.LinkClicked += delegate
                {
                    try
                    {
                        string f = Path.Combine(Application.StartupPath, "免责声明.md");
                        if (File.Exists(f)) Process.Start(new ProcessStartInfo(f) { UseShellExecute = true });
                        else MsgBox("同目录找不到 免责声明.md", "提示");
                    }
                    catch { }
                };

                bool agreed = false;
                chk.CheckedChanged += delegate { btnAgree.Enabled = chk.Checked; };
                btnAgree.Click += delegate { agreed = true; dlg.Close(); };
                btnQuit.Click += delegate { agreed = false; dlg.Close(); };

                dlg.Controls.AddRange(new Control[] {
                    title, sub, box, chk, openDoc, btnAgree, btnQuit
                });
                dlg.AcceptButton = btnAgree;
                dlg.CancelButton = btnQuit;
                dlg.ShowDialog(this);
                return agreed;
            }
        }

        public MainForm() { BuildUi(); }

        // ── 不抢焦点启动 ──
        // 覆写 ShowWithoutActivation：WinForms 窗口显示时默认会激活自己，
        // 这里让它「显示但不激活」，用户正在用的窗口不会被打断。
        public bool NoActivateOnShow = false;
        protected override bool ShowWithoutActivation
        {
            get { return NoActivateOnShow; }
        }
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (NoActivateOnShow)
            {
                // 再压到 Z 序底部作双保险
                try { TopMost = false; } catch { }
            }
        }

        // ── 自检模式 ──
        SelfTestSpec selfTest = null;
        readonly List<string> selfLog = new List<string>();
        System.Windows.Forms.Timer selfWatch = null;
        DateTime selfStart = DateTime.MinValue;
        readonly List<int> selfProgSamples = new List<int>();
        readonly List<int> selfProgTimes = new List<int>();
        int selfLastProg = -1;

        public MainForm(SelfTestSpec spec)
        {
            selfTest = spec;
            BuildUi();
            Load += delegate { BeginSelfTest(); };
        }

        /// <summary>
        /// MessageBox 的统一入口。静默自检模式下不弹窗直接返回，
        /// 否则一个模态框就能让自动化测试永久卡住（这是最难查的一类挂起）。
        /// </summary>
        DialogResult MsgBox(string text, string caption)
        {
            if (selfTest != null && selfTest.Quiet)
            {
                Log("[静默] 拦截弹窗(" + caption + "): " + text.Replace("\n", " "));
                return DialogResult.OK;
            }
            return MessageBox.Show(text, caption);
        }
        DialogResult MsgBox(string text, string caption, MessageBoxButtons buttons)
        {
            if (selfTest != null && selfTest.Quiet)
            {
                Log("[静默] 拦截弹窗(" + caption + "): " + text.Replace("\n", " "));

                // 关键：**不能**无条件返回 Yes。
                //
                // 「需要激活」那个弹窗是 OKCancel，Yes/OK 会走进 DoActivate()
                // ——一个模态的激活对话框。自检是无人值守的，没人点它，
                // 整个进程就永久挂在那里（实测：RESULT 永远不写、UI 卡死）。
                //
                // 所以按语义分开：
                //   · 询问型（OKCancel / YesNo）→ Cancel/No，代表"用户拒绝"
                //   · 通知型（OK only）        → OK，代表"看到了"
                bool asksChoice = buttons == MessageBoxButtons.OKCancel
                               || buttons == MessageBoxButtons.YesNo
                               || buttons == MessageBoxButtons.YesNoCancel
                               || buttons == MessageBoxButtons.RetryCancel;
                if (asksChoice)
                {
                    Log("[静默]   → 按「取消/否」处理，避免走进模态子流程");
                    return buttons == MessageBoxButtons.RetryCancel
                        ? DialogResult.Cancel
                        : (buttons == MessageBoxButtons.OKCancel ? DialogResult.Cancel : DialogResult.No);
                }
                return DialogResult.OK;
            }
            return MessageBox.Show(text, caption, buttons);
        }
        DialogResult MsgBox(IWin32Window owner, string text, string caption)
        {
            return MsgBox(text, caption);
        }
        DialogResult MsgBox(IWin32Window owner, string text, string caption, MessageBoxButtons buttons)
        {
            return MsgBox(text, caption, buttons);
        }
        DialogResult MsgBox(IWin32Window owner, string text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon)
        {
            return MsgBox(text, caption, buttons);
        }


        /// <summary>
        /// 自检模式安全的提示框。
        /// 自检是无人值守跑的，MsgBox 一弹就永远等不到点击 —— 直接卡到 180 秒超时。
        /// 所以自检时只记日志，正常模式才真弹。
        /// </summary>
        DialogResult MsgOrLog(string text, string title, MessageBoxButtons btns = MessageBoxButtons.OK)
        {
            if (selfTest != null)
            {
                SelfLog("[自检跳过弹窗] " + title + ": " + text.Replace("\n", " "));
                return DialogResult.OK;
            }
            // 注意：本项目的 MsgBox 只有 (owner, text, title, buttons) 四参重载，
            // 没有 icon 参数 —— 照抄 WinForms 的 MessageBox.Show 签名会编译失败。
            return MsgBox(this, text, title, btns);
        }

        void SelfLog(string s)
        {
            selfLog.Add(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s);
            Log(s);
        }

        void BeginSelfTest()
        {
            if (selfTest == null) return;

            // 自检旁路：直接改本进程的环境变量，子进程会继承。
            // 比往 ProcessStartInfo.EnvironmentVariables 里塞更可靠 ——
            // 那个 StringDictionary 在 Windows 上遇到 NO_PROXY/no_proxy
            // 这类大小写重复的键会直接抛异常。
            try { Environment.SetEnvironmentVariable("DSH_DL_SELFTEST", "1"); } catch { }
            try
            {
                switch (selfTest.Kind)
                {
                    case "zhihu":
                        tabs.SelectedTab = tabZhihu;
                        txtZhihuUrl.Text = selfTest.Payload;
                        SelfLog("[selftest] 知乎页已填链接: " + selfTest.Payload);
                        break;
                    case "video":
                        tabs.SelectedTab = tabVideo;
                        txtLinks.Text = selfTest.Payload;
                        SelfLog("[selftest] 视频页已填链接: " + selfTest.Payload);
                        break;
                    case "music":
                        tabs.SelectedTab = tabMusic;
                        txtMusicKey.Text = selfTest.Payload;
                        SelfLog("[selftest] 音乐页已填关键词: " + selfTest.Payload);
                        break;
                    case "sites":
                        tabs.SelectedTab = tabSites;
                        txtSiteUrl.Text = selfTest.Payload;
                        SelfLog("[selftest] 站点视频页已填链接: " + selfTest.Payload);
                        break;
                    case "grab":
                        tabs.SelectedTab = tabGrab;
                        txtGrabUrl.Text = selfTest.Payload;
                        SelfLog("[selftest] 抓取页已填地址: " + selfTest.Payload);
                        break;
                    // v1.1.0 三个新页也要能自检，否则回归只能靠手点
                    case "wechat":
                        tabs.SelectedTab = tabWechat;
                        txtWxUrl.Text = selfTest.Payload;
                        SelfLog("[selftest] 公众号页已填链接: " + selfTest.Payload);
                        break;
                    case "playlist":
                        tabs.SelectedTab = tabPlaylist;
                        txtPlUrl.Text = selfTest.Payload;
                        // 自检只下 2 首，避免跑太久
                        numPlLimit.Value = 2;
                        SelfLog("[selftest] 歌单页已填: " + selfTest.Payload);
                        break;
                    case "stock":
                        tabs.SelectedTab = tabStock;
                        cmbStScene.SelectedIndex = 0;   // 用自定义关键词
                        txtStKeyword.Text = selfTest.Payload;
                        numStLimit.Value = 1;
                        SelfLog("[selftest] 素材页已填关键词: " + selfTest.Payload);
                        break;
                    default:
                        SelfLog("[selftest] 未知类型: " + selfTest.Kind);
                        FinishSelfTest(false, "unknown kind");
                        return;
                }
            }
            catch (Exception ex)
            {
                SelfLog("[selftest] 填充失败: " + ex.Message);
                FinishSelfTest(false, ex.Message);
                return;
            }

            selfStart = DateTime.Now;
            selfProgSamples.Clear();
            selfProgTimes.Clear();
            selfLastProg = -1;

            selfWatch = new System.Windows.Forms.Timer();
            selfWatch.Interval = 500;
            selfWatch.Tick += delegate { SelfTick(); };
            selfWatch.Start();

            // 等一轮消息循环再点，确保控件已就绪
            var kick = new System.Windows.Forms.Timer();
            kick.Interval = 400;
            kick.Tick += delegate
            {
                kick.Stop();
                kick.Dispose();
                SelfLog("[selftest] 点击按钮");
                try
                {
                    switch (selfTest.Kind)
                    {
                        case "zhihu": StartZhihu(); break;
                        case "video": StartDownload(); break;
                        case "music": SearchMusic(); break;
                        case "sites": StartSites(); break;
                        case "grab": StartGrab(); break;
                        case "wechat": StartWechat(); break;
                        case "playlist": StartPlaylist(); break;
                        case "stock": StartStock(); break;
                    }
                }
                catch (Exception ex)
                {
                    SelfLog("[selftest] 点击异常: " + ex.Message);
                    FinishSelfTest(false, ex.Message);
                }
            };
            kick.Start();
        }

        void SelfTick()
        {
            if (selfTest == null) return;

            int p = -1;
            try { p = progress.Value; } catch { }
            if (p != selfLastProg)
            {
                selfLastProg = p;
                selfProgSamples.Add(p);
                selfProgTimes.Add((int)(DateTime.Now - selfStart).TotalMilliseconds);
                SelfLog("[selftest] progress=" + p + "%  t=" + (int)(DateTime.Now - selfStart).TotalSeconds + "s");
            }

            bool busy = (engine != null || musicProc != null || zhihuProc != null || siteProc != null || grabProc != null);
            double elapsed = (DateTime.Now - selfStart).TotalSeconds;

            // 空闲 = 任务结束
            if (!busy && elapsed > 1.5)
            {
                FinishSelfTest(p >= 100, null);
                return;
            }

            if (elapsed > 180)
            {
                SelfLog("[selftest] 超时 180 秒未结束，进度=" + p);
                FinishSelfTest(false, "timeout");
            }
        }

        void FinishSelfTest(bool ok, string err)
        {
            if (selfWatch != null) { selfWatch.Stop(); selfWatch.Dispose(); selfWatch = null; }

            var sb = new StringBuilder();
            sb.AppendLine("RESULT=" + (ok ? "PASS" : "FAIL"));
            if (err != null) sb.AppendLine("ERROR=" + err);
            sb.AppendLine("ELAPSED_MS=" + (int)(DateTime.Now - selfStart).TotalMilliseconds);
            sb.AppendLine("FINAL_PROGRESS=" + (selfLastProg < 0 ? 0 : selfLastProg));
            var s1 = new StringBuilder();
            for (int i = 0; i < selfProgSamples.Count; i++) s1.Append(selfProgTimes[i] + "ms:" + selfProgSamples[i] + "% ");
            sb.AppendLine("SEQUENCE=" + s1.ToString().Trim());
            sb.AppendLine("ZHIHU_ROWS=" + zhihuJobs.Count);
            int okRows = 0, badRows = 0;
            foreach (var j in zhihuJobs) { if (j.Failed) badRows++; else if (j.Finished) okRows++; }
            sb.AppendLine("ZHIHU_OK=" + okRows);
            sb.AppendLine("ZHIHU_BAD=" + badRows);
            sb.AppendLine("VIDEO_ROWS=" + jobs.Count);
            sb.AppendLine("SITE_ROWS=" + siteJobs.Count);
            int siteOk = 0, siteBad = 0;
            foreach (var j in siteJobs) { if (j.Failed) siteBad++; else if (j.Finished) siteOk++; }
            sb.AppendLine("SITE_OK=" + siteOk);
            sb.AppendLine("SITE_BAD=" + siteBad);
            sb.AppendLine("GRAB_TEXT_LEN=" + (grabResultLen));
            sb.AppendLine("ARCH=" + (IntPtr.Size == 8 ? "x64" : "x86"));
            sb.AppendLine("---LOG---");
            foreach (var l in selfLog) sb.AppendLine(l);

            string body = sb.ToString();
            if (!string.IsNullOrEmpty(selfTest.ResultFile))
            {
                try { File.WriteAllText(selfTest.ResultFile, body, Encoding.UTF8); } catch { }
            }
            try { Console.WriteLine(body); } catch { }

            // 自检模式自动退出
            var quit = new System.Windows.Forms.Timer();
            quit.Interval = 700;
            quit.Tick += delegate { quit.Stop(); quit.Dispose(); Close(); };
            quit.Start();
        }

        // ═══════════════════════════ UI ═══════════════════════════
        void BuildUi()
        {
            Text = "统一下载器 " + AppVersion + InternalTag + "  ·  抖音/音乐/站点视频/抓取/知乎";
            StartPosition = FormStartPosition.CenterScreen;
            // 8 个标签页（v1.1.0 加了公众号/歌单/素材）在 1060 宽下挤成两行，
            // 底部还会冒滚动箭头，看着像坏了。加宽到 1280。
            ClientSize = new Size(1280, 820);
            MinimumSize = new Size(980, 660);
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(250, 250, 252);

            tabs = new TabControl();
            tabs.Dock = DockStyle.Fill;
            tabs.Font = new Font("Microsoft YaHei UI", 9.5F);

            tabVideo = new TabPage("抖音视频");
            tabMusic = new TabPage("音乐");
            tabGrab = new TabPage("网页抓取");
            tabGrab.BackColor = Color.White;
            tabSites = new TabPage("站点视频");
            tabSites.BackColor = Color.White;
            tabZhihu = new TabPage("知乎");
            // v1.1.0 新增三个页：公众号 / 歌单 / 素材
            tabWechat = new TabPage("公众号");
            tabPlaylist = new TabPage("歌单");
            tabStock = new TabPage("素材");
            tabVideo.BackColor = Color.White;
            tabMusic.BackColor = Color.White;
            tabZhihu.BackColor = Color.White;
            tabWechat.BackColor = Color.White;
            tabPlaylist.BackColor = Color.White;
            tabStock.BackColor = Color.White;

            BuildVideoTab();
            BuildMusicTab();
            BuildSitesTab();
            BuildGrabTab();
            BuildZhihuTab();
            BuildWechatTab();
            BuildPlaylistTab();
            BuildStockTab();

            tabs.TabPages.Add(tabVideo);
            tabs.TabPages.Add(tabMusic);
            tabs.TabPages.Add(tabSites);
            tabs.TabPages.Add(tabGrab);
            tabs.TabPages.Add(tabZhihu);
            tabs.TabPages.Add(tabWechat);
            tabs.TabPages.Add(tabPlaylist);
            tabs.TabPages.Add(tabStock);

            // 底部公共区
            bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = 178;
            bottom.Padding = new Padding(12, 6, 12, 8);
            bottom.BackColor = Color.White;

            progress = new ProgressBar();
            progress.Location = new Point(14, 8);
            progress.Size = new Size(1000, 16);
            progress.Minimum = 0;
            progress.Maximum = 100;

            var lblLog = new Label();
            lblLog.Text = "运行日志";
            lblLog.Location = new Point(14, 30);
            lblLog.AutoSize = true;
            lblLog.ForeColor = Color.FromArgb(80, 80, 90);

            txtLog = new RichTextBox();
            txtLog.Location = new Point(14, 50);
            txtLog.Size = new Size(1000, 116);
            txtLog.ReadOnly = true;
            txtLog.BackColor = Color.FromArgb(30, 30, 34);
            txtLog.ForeColor = Color.FromArgb(200, 200, 205);
            txtLog.BorderStyle = BorderStyle.None;
            txtLog.Font = new Font("Consolas", 8.5F);
            txtLog.WordWrap = false;

            bottom.Controls.AddRange(new Control[] { progress, lblLog, txtLog });
            bottom.Resize += delegate { LayoutBottom(); };

            statusBar = new StatusStrip();
            statusBar.SizingGrip = false;
            statusLabel = new ToolStripStatusLabel("就绪");
            statusBar.Items.Add(statusLabel);

            Controls.Add(tabs);
            Controls.Add(bottom);
            Controls.Add(statusBar);
            BuildMenu();


            Load += delegate
            {
                RelayoutAll();
                BeginInvoke((MethodInvoker)delegate { RelayoutAll(); });
            };

            // 首次启动：强制同意免责声明。
            // 自检模式（--quiet）跳过，否则自动化会被模态框卡死。
            // 启动即检查激活状态，把结果反映到标题栏和状态栏
            Shown += delegate
            {
                if (selfTest != null) return;
                ShowBetaNoticeOnce();
                RefreshLicense(true);
                UpdateLicenseUi();
            };

            Shown += delegate
            {
                if (selfTest != null) return;
                if (EulaAgreed()) return;
                BeginInvoke((MethodInvoker)delegate
                {
                    if (!ShowEulaDialog())
                    {
                        // 不同意就直接退出，不留任何可用入口
                        Log("[退出] 用户未同意免责声明");
                        Close();
                        return;
                    }
                    WriteEulaMark();
                    Log("[协议] 已记录同意: " + EulaMarkPath());
                });
            };
            Resize += delegate
            {
                RelayoutAll();
                BeginInvoke((MethodInvoker)delegate { RelayoutAll(); });
            };
            // 子面板/列表自己的尺寸变化才是可靠信号（父容器 Resize 时子控件还没更新）
            topVideo.Resize += delegate { LayoutVideoTop(); };
            topMusic.Resize += delegate { LayoutMusicTop(); };
            topSites.Resize += delegate { LayoutSitesTop(); };
            topGrab.Resize += delegate { LayoutGrabTop(); };
            // 切换标签页时新页控件刚创建，需要重排一次
            tabs.SelectedIndexChanged += delegate { RelayoutAll(); };
        }

        void RelayoutAll()
        {
            LayoutVideoTop();
            LayoutMusicTop();
            LayoutZhihuTop();
            LayoutBottom();
            LayoutVideoList();
            LayoutMusicList();
            LayoutZhihuList();
            LayoutSitesTop();
            LayoutSitesList();
            LayoutGrabTop();
        }

        // ─────────── 抖音标签页 ───────────
        void BuildVideoTab()
        {
            topVideo = new Panel();
            topVideo.Dock = DockStyle.Top;
            topVideo.Height = 172;
            topVideo.Padding = new Padding(12, 8, 12, 8);
            topVideo.BackColor = Color.White;

            var lblLinks = new Label();
            lblLinks.Text = "链接（可粘贴多条，或直接粘贴抖音分享文案）";
            lblLinks.Location = new Point(14, 10);
            lblLinks.AutoSize = true;
            lblLinks.ForeColor = Color.FromArgb(80, 80, 90);

            txtLinks = new TextBox();
            txtLinks.Multiline = true;
            txtLinks.ScrollBars = ScrollBars.Vertical;
            txtLinks.Location = new Point(14, 32);
            txtLinks.Size = new Size(1000, 58);
            txtLinks.BorderStyle = BorderStyle.FixedSingle;
            txtLinks.Font = new Font("Consolas", 9F);

            var lblQ = new Label();
            lblQ.Text = "画质";
            lblQ.Location = new Point(14, 102);
            lblQ.AutoSize = true;

            cmbQuality = new ComboBox();
            cmbQuality.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbQuality.Items.AddRange(new object[] { "最高画质", "4K (2160p)", "1440p", "1080p", "720p", "540p" });
            cmbQuality.SelectedIndex = 0;
            cmbQuality.Location = new Point(58, 99);
            cmbQuality.Size = new Size(118, 24);

            var lblOut = new Label();
            lblOut.Text = "保存到";
            lblOut.Location = new Point(190, 102);
            lblOut.AutoSize = true;

            txtOut = new TextBox();
            txtOut.Location = new Point(248, 99);
            txtOut.Size = new Size(660, 24);
            txtOut.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

            btnBrowse = new Button();
            btnBrowse.Text = "浏览…";
            btnBrowse.Location = new Point(920, 98);
            btnBrowse.Size = new Size(80, 26);
            btnBrowse.Click += delegate { BrowseInto(txtOut); };

            chkAudio = new CheckBox();
            chkAudio.Text = "图文作品下载原声";
            chkAudio.Location = new Point(14, 136);
            chkAudio.AutoSize = true;
            chkAudio.Checked = true;

            chkHeadful = new CheckBox();
            chkHeadful.Text = "显示浏览器（过验证码用）";
            chkHeadful.Location = new Point(176, 136);
            chkHeadful.AutoSize = true;

            btnClear = new Button();
            btnClear.Text = "清空列表";
            btnClear.Location = new Point(400, 133);
            btnClear.Size = new Size(88, 28);
            btnClear.Click += delegate { ClearList(); };

            btnOpenDir = new Button();
            btnOpenDir.Text = "打开目录";
            btnOpenDir.Location = new Point(496, 133);
            btnOpenDir.Size = new Size(88, 28);
            btnOpenDir.Click += delegate { OpenDir(txtOut.Text); };

            btnStart = new Button();
            btnStart.Text = "开始下载";
            btnStart.Location = new Point(700, 130);
            btnStart.Size = new Size(132, 34);
            btnStart.BackColor = Color.FromArgb(0, 120, 212);
            btnStart.ForeColor = Color.White;
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
            btnStart.Click += delegate { StartDownload(); };

            btnStop = new Button();
            btnStop.Text = "停止";
            btnStop.Location = new Point(868, 130);
            btnStop.Size = new Size(92, 34);
            btnStop.Enabled = false;
            btnStop.FlatStyle = FlatStyle.Flat;
            btnStop.Click += delegate { StopDownload(); };

            topVideo.Controls.AddRange(new Control[] {
                lblLinks, txtLinks, lblQ, cmbQuality, lblOut, txtOut, btnBrowse,
                chkAudio, chkHeadful, btnClear, btnOpenDir, btnStart, btnStop
            });

            listTasks = new ListView();
            listTasks.Dock = DockStyle.Fill;
            listTasks.View = View.Details;
            listTasks.FullRowSelect = true;
            listTasks.BorderStyle = BorderStyle.None;
            listTasks.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            listTasks.Columns.Add("状态", 92);
            listTasks.Columns.Add("标题", 340);
            listTasks.Columns.Add("类型", 120);
            listTasks.Columns.Add("画质", 110);
            listTasks.Columns.Add("文件", 80);
            listTasks.Columns.Add("大小", 80);
            listTasks.DoubleClick += delegate { OpenDir(txtOut.Text); };
            listTasks.Resize += delegate { LayoutVideoList(); };

            tabVideo.Controls.Add(listTasks);
            tabVideo.Controls.Add(topVideo);
        }

        // ─────────── 音乐标签页 ───────────
        void BuildMusicTab()
        {
            topMusic = new Panel();
            topMusic.Dock = DockStyle.Top;
            topMusic.Height = 150;
            topMusic.Padding = new Padding(12, 8, 12, 8);
            topMusic.BackColor = Color.White;

            var lblKey = new Label();
            lblKey.Text = "搜索歌曲";
            lblKey.Location = new Point(14, 14);
            lblKey.AutoSize = true;
            lblKey.ForeColor = Color.FromArgb(80, 80, 90);

            txtMusicKey = new TextBox();
            txtMusicKey.Location = new Point(14, 36);
            txtMusicKey.Size = new Size(360, 26);
            txtMusicKey.Font = new Font("Microsoft YaHei UI", 10F);
            txtMusicKey.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; SearchMusic(); }
            };

            btnMusicSearch = new Button();
            btnMusicSearch.Text = "搜索对比";
            btnMusicSearch.Location = new Point(384, 35);
            btnMusicSearch.Size = new Size(110, 28);
            btnMusicSearch.BackColor = Color.FromArgb(0, 120, 212);
            btnMusicSearch.ForeColor = Color.White;
            btnMusicSearch.FlatStyle = FlatStyle.Flat;
            btnMusicSearch.FlatAppearance.BorderSize = 0;
            btnMusicSearch.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
            btnMusicSearch.Click += delegate { SearchMusic(); };

            var lblLimit = new Label();
            lblLimit.Text = "每平台";
            lblLimit.Location = new Point(364, 82);
            lblLimit.AutoSize = true;

            numLimit = new NumericUpDown();
            numLimit.Location = new Point(412, 78);
            numLimit.Size = new Size(50, 24);
            numLimit.Minimum = 1;
            numLimit.Maximum = 20;
            numLimit.Value = 5;

            var lblMO = new Label();
            lblMO.Text = "保存到";
            lblMO.Location = new Point(472, 82);
            lblMO.AutoSize = true;

            txtMusicOut = new TextBox();
            txtMusicOut.Location = new Point(530, 78);
            txtMusicOut.Size = new Size(300, 24);
            txtMusicOut.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Music");

            btnMusicBrowse = new Button();
            btnMusicBrowse.Text = "…";
            btnMusicBrowse.Location = new Point(842, 77);
            btnMusicBrowse.Size = new Size(32, 26);
            btnMusicBrowse.Click += delegate { BrowseInto(txtMusicOut); };

            btnMusicOpen = new Button();
            btnMusicOpen.Text = "打开目录";
            btnMusicOpen.Location = new Point(882, 77);
            btnMusicOpen.Size = new Size(88, 26);
            btnMusicOpen.Click += delegate { OpenDir(txtMusicOut.Text); };

            btnMusicBest = new Button();
            btnMusicBest.Text = "下载最优 ★";
            btnMusicBest.Location = new Point(14, 76);
            btnMusicBest.Size = new Size(120, 30);
            btnMusicBest.BackColor = Color.FromArgb(16, 137, 62);
            btnMusicBest.ForeColor = Color.White;
            btnMusicBest.FlatStyle = FlatStyle.Flat;
            btnMusicBest.FlatAppearance.BorderSize = 0;
            btnMusicBest.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
            btnMusicBest.Click += delegate { DownloadBestMusic(); };

            btnMusicDownload = new Button();
            btnMusicDownload.Text = "下载选中";
            btnMusicDownload.Location = new Point(142, 76);
            btnMusicDownload.Size = new Size(110, 30);
            btnMusicDownload.FlatStyle = FlatStyle.Flat;
            btnMusicDownload.Click += delegate { DownloadSelectedMusic(); };

            btnMusicPreview = new Button();
            btnMusicPreview.Text = "♪ 试听";
            btnMusicPreview.Location = new Point(260, 76);
            btnMusicPreview.Size = new Size(90, 30);
            btnMusicPreview.FlatStyle = FlatStyle.Flat;
            btnMusicPreview.ForeColor = Color.FromArgb(0, 100, 180);
            btnMusicPreview.Click += delegate { PreviewSelectedMusic(); };

            // 过滤行：格式 + 最低码率
            var lblFmt = new Label();
            lblFmt.Text = "格式";
            lblFmt.Location = new Point(366, 118);
            lblFmt.AutoSize = true;

            chkFmtMp3 = new CheckBox();
            chkFmtMp3.Text = "MP3";
            chkFmtMp3.Location = new Point(404, 117);
            chkFmtMp3.AutoSize = true;

            chkFmtM4a = new CheckBox();
            chkFmtM4a.Text = "M4A";
            chkFmtM4a.Location = new Point(462, 117);
            chkFmtM4a.AutoSize = true;

            chkFmtFlac = new CheckBox();
            chkFmtFlac.Text = "FLAC";
            chkFmtFlac.Location = new Point(520, 117);
            chkFmtFlac.AutoSize = true;

            var lblKbps = new Label();
            lblKbps.Text = "最低码率";
            lblKbps.Location = new Point(588, 118);
            lblKbps.AutoSize = true;

            cmbMinKbps = new ComboBox();
            cmbMinKbps.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbMinKbps.Items.AddRange(new object[] { "不限", "≥64 kbps", "≥128 kbps", "≥192 kbps", "≥256 kbps", "≥320 kbps" });
            cmbMinKbps.SelectedIndex = 0;
            cmbMinKbps.Location = new Point(652, 115);
            cmbMinKbps.Size = new Size(110, 24);

            topMusic.Controls.AddRange(new Control[] {
                lblKey, txtMusicKey, btnMusicSearch,
                btnMusicBest, btnMusicDownload, btnMusicPreview,
                lblLimit, numLimit, lblMO, txtMusicOut, btnMusicBrowse, btnMusicOpen,
                lblFmt, chkFmtMp3, chkFmtM4a, chkFmtFlac, lblKbps, cmbMinKbps
            });

            listMusic = new ListView();
            listMusic.Dock = DockStyle.Fill;
            listMusic.View = View.Details;
            listMusic.FullRowSelect = true;
            listMusic.BorderStyle = BorderStyle.None;
            listMusic.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            listMusic.Columns.Add("平台", 84);
            listMusic.Columns.Add("歌名", 300);
            listMusic.Columns.Add("歌手", 190);
            listMusic.Columns.Add("状态", 70);
            listMusic.Columns.Add("大小", 84);
            listMusic.Columns.Add("格式", 60);
            listMusic.Columns.Add("推荐", 76);
            listMusic.DoubleClick += delegate { DownloadSelectedMusic(); };
            listMusic.Resize += delegate { LayoutMusicList(); };

            tabMusic.Controls.Add(listMusic);
            tabMusic.Controls.Add(topMusic);
        }

        // ─────────── 站点视频标签页 ───────────
        void BuildSitesTab()
        {
            topSites = new Panel();
            topSites.Dock = DockStyle.Top;
            topSites.Height = 176;
            topSites.Padding = new Padding(12, 8, 12, 8);
            topSites.BackColor = Color.White;

            var lblU = new Label();
            lblU.Text = "视频链接（B站 / 优酷 / 腾讯 / 芒果，可多行）";
            lblU.Location = new Point(14, 10);
            lblU.AutoSize = true;
            lblU.ForeColor = Color.FromArgb(80, 80, 90);

            txtSiteUrl = new TextBox();
            txtSiteUrl.Multiline = true;
            txtSiteUrl.ScrollBars = ScrollBars.Vertical;
            txtSiteUrl.Location = new Point(14, 32);
            txtSiteUrl.Size = new Size(900, 56);
            txtSiteUrl.BorderStyle = BorderStyle.FixedSingle;
            txtSiteUrl.Font = new Font("Consolas", 9F);

            var lblQ = new Label();
            lblQ.Text = "清晰度";
            lblQ.Location = new Point(14, 100);
            lblQ.AutoSize = true;

            cmbSiteQuality = new ComboBox();
            cmbSiteQuality.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbSiteQuality.Items.AddRange(new object[] {
                "最高画质", "4K (2160p)", "1440p", "1080p", "720p", "480p", "360p"
            });
            cmbSiteQuality.SelectedIndex = 0;
            cmbSiteQuality.Location = new Point(66, 97);
            cmbSiteQuality.Size = new Size(122, 24);

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(200, 100);
            lblO.AutoSize = true;

            txtSiteOut = new TextBox();
            txtSiteOut.Location = new Point(258, 97);
            txtSiteOut.Size = new Size(560, 24);
            txtSiteOut.Text = Path.Combine(Application.StartupPath, "downloads", "视频");

            btnSiteBrowse = new Button();
            btnSiteBrowse.Text = "浏览…";
            btnSiteBrowse.Location = new Point(828, 96);
            btnSiteBrowse.Size = new Size(76, 26);
            btnSiteBrowse.Click += delegate { BrowseInto(txtSiteOut); };

            btnSiteOpen = new Button();
            btnSiteOpen.Text = "打开目录";
            btnSiteOpen.Location = new Point(912, 96);
            btnSiteOpen.Size = new Size(88, 26);
            btnSiteOpen.Click += delegate { OpenDir(txtSiteOut.Text); };

            chkSiteSubs = new CheckBox();
            chkSiteSubs.Text = "下载字幕";
            chkSiteSubs.Location = new Point(14, 136);
            chkSiteSubs.AutoSize = true;

            chkSiteAllParts = new CheckBox();
            chkSiteAllParts.Text = "整季/全部分P";
            chkSiteAllParts.Location = new Point(118, 136);
            chkSiteAllParts.AutoSize = true;

            var lblCk = new Label();
            lblCk.Text = "登录态";
            lblCk.Location = new Point(246, 138);
            lblCk.AutoSize = true;
            lblCk.ForeColor = Color.FromArgb(80, 80, 90);

            txtSiteCookieBrowser = new TextBox();
            txtSiteCookieBrowser.Location = new Point(302, 134);
            txtSiteCookieBrowser.Size = new Size(96, 24);
            txtSiteCookieBrowser.Text = "";
            txtSiteCookieBrowser.Font = new Font("Consolas", 9F);

            var lblCkHint = new Label();
            lblCkHint.Text = "（留空=不用；要塞 chrome/edge 时请先完全退出浏览器）";
            lblCkHint.Location = new Point(406, 138);
            lblCkHint.AutoSize = true;
            lblCkHint.ForeColor = Color.FromArgb(140, 140, 150);

            btnSiteStart = new Button();
            btnSiteStart.Text = "开始下载";
            btnSiteStart.Location = new Point(828, 130);
            btnSiteStart.Size = new Size(172, 34);
            btnSiteStart.BackColor = Color.FromArgb(0, 120, 212);
            btnSiteStart.ForeColor = Color.White;
            btnSiteStart.FlatStyle = FlatStyle.Flat;
            btnSiteStart.FlatAppearance.BorderSize = 0;
            btnSiteStart.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
            btnSiteStart.Click += delegate { StartSites(); };

            btnSiteStop = new Button();
            btnSiteStop.Text = "停止";
            btnSiteStop.Location = new Point(828, 168);
            btnSiteStop.Size = new Size(172, 26);
            btnSiteStop.Enabled = false;
            btnSiteStop.FlatStyle = FlatStyle.Flat;
            btnSiteStop.Visible = false;
            btnSiteStop.Click += delegate { StopSites(); };

            topSites.Controls.AddRange(new Control[] {
                lblU, txtSiteUrl, lblQ, cmbSiteQuality, lblO, txtSiteOut,
                btnSiteBrowse, btnSiteOpen, chkSiteSubs, chkSiteAllParts,
                lblCk, txtSiteCookieBrowser, lblCkHint, btnSiteStart
            });

            listSites = new ListView();
            listSites.Dock = DockStyle.Fill;
            listSites.View = View.Details;
            listSites.FullRowSelect = true;
            listSites.BorderStyle = BorderStyle.None;
            listSites.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            listSites.Columns.Add("状态", 92);
            listSites.Columns.Add("标题", 360);
            listSites.Columns.Add("清晰度", 110);
            listSites.Columns.Add("文件", 80);
            listSites.Columns.Add("大小", 90);
            listSites.DoubleClick += delegate { OpenDir(txtSiteOut.Text); };
            listSites.Resize += delegate { LayoutSitesList(); };

            tabSites.Controls.Add(listSites);
            tabSites.Controls.Add(topSites);
        }

        void LayoutSitesTop()
        {
            if (topSites == null) return;
            int w = topSites.ClientSize.Width;
            int pad = S(14);
            txtSiteUrl.Width = Math.Max(S(200), w - pad * 2);

            int x = w - pad;
            btnSiteOpen.Left = x - S(88); x = btnSiteOpen.Left - S(8);
            btnSiteBrowse.Left = x - S(76); x = btnSiteBrowse.Left - S(8);
            txtSiteOut.Left = S(258);
            txtSiteOut.Width = Math.Max(S(120), x - S(258));
            btnSiteOpen.BringToFront();
            btnSiteBrowse.BringToFront();

            btnSiteStart.Left = w - pad - S(172);
            btnSiteStart.Width = S(172);
        }

        void LayoutSitesList()
        {
            if (listSites == null || listSites.Columns.Count < 5) return;
            int avail = listSites.ClientSize.Width - S(28);
            int fixedSum = S(92) + S(110) + S(80) + S(90);
            listSites.Columns[1].Width = Math.Max(S(160), avail - fixedSum);
        }

        // ─────────── 网页抓取标签页（测试） ───────────
        void BuildGrabTab()
        {
            topGrab = new Panel();
            topGrab.Dock = DockStyle.Top;
            topGrab.Height = 156;
            topGrab.Padding = new Padding(12, 8, 12, 8);
            topGrab.BackColor = Color.White;

            var lblU = new Label();
            lblU.Text = "网页地址（通用抓取，不针对特定站点；遇到 403 请手动在浏览器打开一次）";
            lblU.Location = new Point(14, 10);
            lblU.AutoSize = true;
            lblU.ForeColor = Color.FromArgb(80, 80, 90);

            txtGrabUrl = new TextBox();
            txtGrabUrl.Location = new Point(14, 32);
            txtGrabUrl.Size = new Size(1000, 26);
            txtGrabUrl.BorderStyle = BorderStyle.FixedSingle;
            txtGrabUrl.Font = new Font("Consolas", 9F);

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(14, 70);
            lblO.AutoSize = true;

            txtGrabOut = new TextBox();
            txtGrabOut.Location = new Point(72, 67);
            txtGrabOut.Size = new Size(640, 24);
            txtGrabOut.Text = Path.Combine(Application.StartupPath, "downloads", "抓取");

            btnGrabBrowse = new Button();
            btnGrabBrowse.Text = "浏览…";
            btnGrabBrowse.Location = new Point(720, 66);
            btnGrabBrowse.Size = new Size(76, 26);
            btnGrabBrowse.Click += delegate { BrowseInto(txtGrabOut); };

            btnGrabOpen = new Button();
            btnGrabOpen.Text = "打开目录";
            btnGrabOpen.Location = new Point(804, 66);
            btnGrabOpen.Size = new Size(88, 26);
            btnGrabOpen.Click += delegate { OpenDir(txtGrabOut.Text); };

            chkGrabText = new CheckBox();
            chkGrabText.Text = "保存正文";
            chkGrabText.Location = new Point(14, 104);
            chkGrabText.AutoSize = true;
            chkGrabText.Checked = true;

            chkGrabImages = new CheckBox();
            chkGrabImages.Text = "下载图片";
            chkGrabImages.Location = new Point(112, 104);
            chkGrabImages.AutoSize = true;

            chkGrabLinks = new CheckBox();
            chkGrabLinks.Text = "导出链接清单";
            chkGrabLinks.Location = new Point(206, 104);
            chkGrabLinks.AutoSize = true;

            var lblL = new Label();
            lblL.Text = "最多图片";
            lblL.Location = new Point(328, 106);
            lblL.AutoSize = true;

            numGrabLimit = new NumericUpDown();
            numGrabLimit.Location = new Point(392, 102);
            numGrabLimit.Size = new Size(60, 24);
            numGrabLimit.Minimum = 1;
            numGrabLimit.Maximum = 2000;
            numGrabLimit.Value = 50;

            btnGrabStart = new Button();
            btnGrabStart.Text = "开始抓取";
            btnGrabStart.Location = new Point(828, 98);
            btnGrabStart.Size = new Size(172, 36);
            btnGrabStart.BackColor = Color.FromArgb(0, 120, 212);
            btnGrabStart.ForeColor = Color.White;
            btnGrabStart.FlatStyle = FlatStyle.Flat;
            btnGrabStart.FlatAppearance.BorderSize = 0;
            btnGrabStart.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
            btnGrabStart.Click += delegate { StartGrab(); };

            topGrab.Controls.AddRange(new Control[] {
                lblU, txtGrabUrl, lblO, txtGrabOut, btnGrabBrowse, btnGrabOpen,
                chkGrabText, chkGrabImages, chkGrabLinks, lblL, numGrabLimit, btnGrabStart
            });

            txtGrabResult = new RichTextBox();
            txtGrabResult.Dock = DockStyle.Fill;
            txtGrabResult.ReadOnly = true;
            txtGrabResult.BorderStyle = BorderStyle.None;
            txtGrabResult.BackColor = Color.FromArgb(250, 250, 252);
            txtGrabResult.Font = new Font("Microsoft YaHei UI", 9F);

            tabGrab.Controls.Add(txtGrabResult);
            tabGrab.Controls.Add(topGrab);
        }

        void LayoutGrabTop()
        {
            if (topGrab == null) return;
            int w = topGrab.ClientSize.Width;
            int pad = S(14);
            txtGrabUrl.Width = Math.Max(S(200), w - pad * 2);

            int x = w - pad;
            btnGrabOpen.Left = x - S(88); x = btnGrabOpen.Left - S(8);
            btnGrabBrowse.Left = x - S(76); x = btnGrabBrowse.Left - S(8);
            txtGrabOut.Left = S(72);
            txtGrabOut.Width = Math.Max(S(120), x - S(72));
            btnGrabOpen.BringToFront();
            btnGrabBrowse.BringToFront();

            btnGrabStart.Left = w - pad - S(172);
            btnGrabStart.Width = S(172);
        }

        void StartGrab()
        {
            if (!RequireLicense("网页抓取")) return;
            if (grabProc != null) { MsgBox("抓取进行中，请稍等", "提示"); return; }

            string url = txtGrabUrl.Text.Trim();
            if (url.Length == 0) { MsgBox("请先输入网页地址", "提示"); txtGrabUrl.Focus(); return; }
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                url = "https://" + url;
                txtGrabUrl.Text = url;
            }

            bool uni;
            string eng = FindEngine("下载器.exe", out uni);
            if (eng == null) { MsgBox("找不到引擎", "错误"); return; }

            string outDir = txtGrabOut.Text.Trim();
            if (outDir.Length == 0)
            {
                outDir = Path.Combine(Application.StartupPath, "downloads", "抓取");
                txtGrabOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgBox("无法创建目录:\n" + ex.Message, "错误"); return; }

            var args = new StringBuilder();
            args.Append(Quote(url)).Append(" -o ").Append(Quote(outDir));
            args.Append(" --limit ").Append((int)numGrabLimit.Value);
            bool any = false;
            if (chkGrabText.Checked) { args.Append(" --text"); any = true; }
            if (chkGrabImages.Checked) { args.Append(" --images"); any = true; }
            if (chkGrabLinks.Checked) { args.Append(" --links"); any = true; }
            if (!any) args.Append(" --text");

            var psi = new ProcessStartInfo();
            psi.FileName = eng;
            psi.Arguments = uni ? "grab " + args.ToString() : args.ToString();
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;
            // 自检模式下告诉引擎跳过激活闸门（否则回归测试全被拦）
            //
            // 注意：ProcessStartInfo.EnvironmentVariables 在 Windows 上大小写不敏感，
            // 而系统里常同时存在 NO_PROXY 和 no_proxy 两个键。
            // 直接赋值会抛「已添加项。字典中的关键字已存在」——这不是自检专属问题，
            // 任何设置了大小写重复环境变量的用户都会踩到，所以必须按大小写不敏感的方式写。
            // 自检旁路已通过进程级环境变量设置（见 BeginSelfTest），子进程自动继承

            txtGrabResult.Clear();
            btnGrabStart.Enabled = false;
            statusLabel.Text = "抓取中…";
            Log("");
            Log("━━━ 网页抓取 ━━━");
            txtGrabResult.AppendText("━━━ 网页抓取 ━━━" + Environment.NewLine);
            txtGrabResult.AppendText(url + Environment.NewLine + Environment.NewLine);

            try
            {
                var p = new Process();
                p.StartInfo = psi;
                grabProc = p;
                p.Start();

                Thread t = new Thread(delegate ()
                {
                    try
                    {
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null) PostGrab(line);
                    }
                    catch { }
                    try
                    {
                        string e;
                        while ((e = p.StandardError.ReadLine()) != null) PostGrab(e);
                    }
                    catch { }
                    try { p.WaitForExit(); } catch { }

                    BeginInvoke((MethodInvoker)delegate
                    {
                        int code = -1;
                        try { code = p.ExitCode; } catch { }
                        grabProc = null;
                        btnGrabStart.Enabled = true;
                        statusLabel.Text = code == 0 ? "抓取完成" : "抓取结束（有错误）";
                        // 抓取没有天然的百分比，完成时直接走满，
                        // 否则自检（以及用户的进度条）会一直停在 0
                        try { progress.Value = code == 0 ? 100 : 0; } catch { }
                        Log(code == 0 ? "━━━ 完成 ━━━" : "━━━ 结束（退出码 " + code + "）━━━");
                        try { p.Dispose(); } catch { }
                    });
                });
                t.IsBackground = true;
                t.Start();
            }
            catch (Exception ex)
            {
                grabProc = null;
                btnGrabStart.Enabled = true;
                Log("[错误] " + ex.Message);
                MsgBox("启动失败:\n" + ex.Message, "错误");
            }
        }

        void PostGrab(string line)
        {
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    if (txtGrabResult == null || txtGrabResult.IsDisposed) return;
                    // 进度行用 \r 覆盖式输出，这里只保留最新一段
                    string t = line;
                    if (t.Contains("\r")) t = t.Substring(t.LastIndexOf('\r') + 1);
                    t = t.TrimEnd();
                    if (t.Length == 0) return;
                    if (t.StartsWith("    图片 ")) return;   // 刷屏，丢掉
                    txtGrabResult.AppendText(t + Environment.NewLine);
                    grabResultLen = txtGrabResult.TextLength;
                    txtGrabResult.SelectionStart = txtGrabResult.TextLength;
                    txtGrabResult.ScrollToCaret();
                    if (!t.StartsWith("  ")) Log(t);
                });
            }
            catch { }
        }

        // ─────────── 知乎标签页 ───────────
        void BuildZhihuTab()
        {
            topZhihu = new Panel();
            topZhihu.Dock = DockStyle.Top;
            topZhihu.Height = 150;
            topZhihu.Padding = new Padding(12, 8, 12, 8);
            topZhihu.BackColor = Color.White;

            var lblU = new Label();
            lblU.Text = "知乎链接（专栏文章 / 回答，可粘贴多条）";
            lblU.Location = new Point(14, 10);
            lblU.AutoSize = true;
            lblU.ForeColor = Color.FromArgb(80, 80, 90);

            txtZhihuUrl = new TextBox();
            txtZhihuUrl.Multiline = true;
            txtZhihuUrl.ScrollBars = ScrollBars.Vertical;
            txtZhihuUrl.Location = new Point(14, 32);
            txtZhihuUrl.Size = new Size(900, 52);
            txtZhihuUrl.BorderStyle = BorderStyle.FixedSingle;
            txtZhihuUrl.Font = new Font("Consolas", 9F);

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(14, 94);
            lblO.AutoSize = true;

            txtZhihuOut = new TextBox();
            txtZhihuOut.Location = new Point(72, 91);
            txtZhihuOut.Size = new Size(600, 24);
            txtZhihuOut.Text = Path.Combine(Application.StartupPath, "downloads", "文章");

            btnZhihuBrowse = new Button();
            btnZhihuBrowse.Text = "浏览…";
            btnZhihuBrowse.Location = new Point(680, 90);
            btnZhihuBrowse.Size = new Size(80, 26);
            btnZhihuBrowse.Click += delegate { BrowseInto(txtZhihuOut); };

            btnZhihuOpen = new Button();
            btnZhihuOpen.Text = "打开目录";
            btnZhihuOpen.Location = new Point(768, 90);
            btnZhihuOpen.Size = new Size(88, 26);
            btnZhihuOpen.Click += delegate { OpenDir(txtZhihuOut.Text); };

            chkZhihuHeadful = new CheckBox();
            chkZhihuHeadful.Text = "显示浏览器（过验证/登录用）";
            chkZhihuHeadful.Location = new Point(14, 122);
            chkZhihuHeadful.AutoSize = true;

            chkZhihuClip = new CheckBox();
            chkZhihuClip.Text = "下载图片到本地";
            chkZhihuClip.Location = new Point(248, 122);
            chkZhihuClip.AutoSize = true;
            // 默认勾上（引擎默认行为就是本地化），与引擎保持一致
            chkZhihuClip.Checked = true;

            var lblZf = new Label();
            lblZf.Text = "输出格式";
            lblZf.Location = new Point(430, 124);
            lblZf.AutoSize = true;

            chkFmtMd = new CheckBox();
            chkFmtMd.Text = "Markdown";
            chkFmtMd.Location = new Point(496, 122);
            chkFmtMd.AutoSize = true;
            chkFmtMd.Checked = true;

            chkFmtTxt = new CheckBox();
            chkFmtTxt.Text = "纯文本";
            chkFmtTxt.Location = new Point(596, 122);
            chkFmtTxt.AutoSize = true;

            chkFmtDocx = new CheckBox();
            chkFmtDocx.Text = "Word (docx)";
            chkFmtDocx.Location = new Point(676, 122);
            chkFmtDocx.AutoSize = true;

            btnZhihuStart = new Button();
            btnZhihuStart.Text = "开始抓取";
            btnZhihuStart.Location = new Point(860, 86);
            btnZhihuStart.Size = new Size(120, 34);
            btnZhihuStart.BackColor = Color.FromArgb(0, 120, 212);
            btnZhihuStart.ForeColor = Color.White;
            btnZhihuStart.FlatStyle = FlatStyle.Flat;
            btnZhihuStart.FlatAppearance.BorderSize = 0;
            btnZhihuStart.Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
            btnZhihuStart.Click += delegate { StartZhihu(); };

            btnZhihuStop = new Button();
            btnZhihuStop.Text = "停止";
            btnZhihuStop.Location = new Point(860, 122);
            btnZhihuStop.Size = new Size(120, 26);
            btnZhihuStop.Enabled = false;
            btnZhihuStop.FlatStyle = FlatStyle.Flat;
            btnZhihuStop.Click += delegate { StopZhihu(); };

            topZhihu.Controls.AddRange(new Control[] {
                lblU, txtZhihuUrl, lblO, txtZhihuOut, btnZhihuBrowse, btnZhihuOpen,
                chkZhihuHeadful, chkZhihuClip, lblZf, chkFmtMd, chkFmtTxt, chkFmtDocx,
                btnZhihuStart, btnZhihuStop
            });

            listZhihu = new ListView();
            listZhihu.Dock = DockStyle.Fill;
            listZhihu.View = View.Details;
            listZhihu.FullRowSelect = true;
            listZhihu.BorderStyle = BorderStyle.None;
            listZhihu.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            listZhihu.Columns.Add("状态", 90);
            listZhihu.Columns.Add("标题", 400);
            listZhihu.Columns.Add("字数", 80);
            listZhihu.Columns.Add("图片", 70);
            listZhihu.Columns.Add("文件", 260);
            listZhihu.DoubleClick += delegate { OpenDir(txtZhihuOut.Text); };
            listZhihu.Resize += delegate { LayoutZhihuList(); };

            tabZhihu.Controls.Add(listZhihu);
            tabZhihu.Controls.Add(topZhihu);
        }

        // ═══════════════════════════ 公众号（v1.1.0）═══════════════════════════
        // 公众号是纯 HTTP 抓取，不需要浏览器 —— 所以这一页没有"显示浏览器"选项。
        // 引擎取 <div id="js_content">，比通用抓取准得多。
        void BuildWechatTab()
        {
            topWechat = new Panel();
            topWechat.Dock = DockStyle.Top;
            topWechat.Height = 150;
            topWechat.Padding = new Padding(12, 8, 12, 8);
            topWechat.BackColor = Color.White;

            var lblU = new Label();
            lblU.Text = "公众号文章链接（可粘贴多条，短链长链都行）· 转 Markdown / Word";
            lblU.Location = new Point(14, 10);
            lblU.AutoSize = true;
            lblU.ForeColor = Color.FromArgb(80, 80, 90);

            txtWxUrl = new TextBox();
            txtWxUrl.Multiline = true;
            txtWxUrl.ScrollBars = ScrollBars.Vertical;
            txtWxUrl.Location = new Point(14, 32);
            txtWxUrl.Size = new Size(1120, 52);
            txtWxUrl.BorderStyle = BorderStyle.FixedSingle;
            txtWxUrl.Font = new Font("Consolas", 9F);
            txtWxUrl.Text = "https://mp.weixin.qq.com/s/";

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(14, 94);
            lblO.AutoSize = true;

            txtWxOut = new TextBox();
            txtWxOut.Location = new Point(72, 91);
            txtWxOut.Size = new Size(800, 24);
            txtWxOut.Text = Path.Combine(Application.StartupPath, "downloads", "公众号");

            btnWxBrowse = new Button();
            btnWxBrowse.Text = "浏览…";
            btnWxBrowse.Location = new Point(880, 90);
            btnWxBrowse.Size = new Size(80, 26);
            btnWxBrowse.Click += delegate { BrowseInto(txtWxOut); };

            btnWxOpen = new Button();
            btnWxOpen.Text = "打开目录";
            btnWxOpen.Location = new Point(968, 90);
            btnWxOpen.Size = new Size(88, 26);
            btnWxOpen.Click += delegate { OpenDir(txtWxOut.Text); };

            chkWxNoImages = new CheckBox();
            chkWxNoImages.Text = "不下载图片（只留远程链接）";
            chkWxNoImages.Location = new Point(14, 122);
            chkWxNoImages.AutoSize = true;

            chkWxDocx = new CheckBox();
            chkWxDocx.Text = "同时导出 Word";
            chkWxDocx.Location = new Point(240, 122);
            chkWxDocx.AutoSize = true;

            btnWxStart = new Button();
            btnWxStart.Text = "开始下载";
            btnWxStart.Location = new Point(1060, 118);
            btnWxStart.Size = new Size(88, 28);
            btnWxStart.Click += delegate { StartWechat(); };

            topWechat.Controls.Add(lblU);
            topWechat.Controls.Add(txtWxUrl);
            topWechat.Controls.Add(lblO);
            topWechat.Controls.Add(txtWxOut);
            topWechat.Controls.Add(btnWxBrowse);
            topWechat.Controls.Add(btnWxOpen);
            topWechat.Controls.Add(chkWxNoImages);
            topWechat.Controls.Add(chkWxDocx);
            topWechat.Controls.Add(btnWxStart);

            tabWechat.Controls.Add(topWechat);
        }

        // ═══════════════════════════ 歌单（v1.1.0）═══════════════════════════
        // 只支持网易云（酷我曲目不下发、QQ 要签名）。
        // 断点续传靠"已存在就跳过"，所以重复跑同一歌单不会重复下载。
        void BuildPlaylistTab()
        {
            topPlaylist = new Panel();
            topPlaylist.Dock = DockStyle.Top;
            topPlaylist.Height = 150;
            topPlaylist.Padding = new Padding(12, 8, 12, 8);
            topPlaylist.BackColor = Color.White;

            var lblU = new Label();
            lblU.Text = "网易云歌单链接（或直接填数字 ID）· 批量下配乐";
            lblU.Location = new Point(14, 10);
            lblU.AutoSize = true;
            lblU.ForeColor = Color.FromArgb(80, 80, 90);

            txtPlUrl = new TextBox();
            txtPlUrl.Location = new Point(14, 32);
            txtPlUrl.Size = new Size(1120, 24);
            txtPlUrl.BorderStyle = BorderStyle.FixedSingle;
            txtPlUrl.Font = new Font("Consolas", 9F);
            txtPlUrl.Text = "https://music.163.com/playlist?id=3778678";

            var lblN = new Label();
            lblN.Text = "下载数量";
            lblN.Location = new Point(14, 70);
            lblN.AutoSize = true;

            numPlLimit = new NumericUpDown();
            numPlLimit.Location = new Point(86, 67);
            numPlLimit.Size = new Size(70, 24);
            numPlLimit.Minimum = 0;
            numPlLimit.Maximum = 9999;
            numPlLimit.Value = 10;
            var tipPl = new ToolTip();
            tipPl.SetToolTip(numPlLimit, "0 = 全部下载。建议先下 10 首试水。");

            var lblTip = new Label();
            lblTip.Text = "（0 = 全部）";
            lblTip.Location = new Point(160, 70);
            lblTip.AutoSize = true;
            lblTip.ForeColor = Color.Gray;

            chkPlMeta = new CheckBox();
            chkPlMeta.Text = "顺带抓歌词和封面";
            chkPlMeta.Location = new Point(300, 68);
            chkPlMeta.AutoSize = true;

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(14, 106);
            lblO.AutoSize = true;

            txtPlOut = new TextBox();
            txtPlOut.Location = new Point(72, 103);
            txtPlOut.Size = new Size(800, 24);
            txtPlOut.Text = Path.Combine(Application.StartupPath, "downloads", "歌单");

            btnPlBrowse = new Button();
            btnPlBrowse.Text = "浏览…";
            btnPlBrowse.Location = new Point(880, 102);
            btnPlBrowse.Size = new Size(80, 26);
            btnPlBrowse.Click += delegate { BrowseInto(txtPlOut); };

            btnPlOpen = new Button();
            btnPlOpen.Text = "打开目录";
            btnPlOpen.Location = new Point(968, 102);
            btnPlOpen.Size = new Size(88, 26);
            btnPlOpen.Click += delegate { OpenDir(txtPlOut.Text); };

            btnPlStart = new Button();
            btnPlStart.Text = "开始下载";
            btnPlStart.Location = new Point(1060, 100);
            btnPlStart.Size = new Size(88, 28);
            btnPlStart.Click += delegate { StartPlaylist(); };

            topPlaylist.Controls.Add(lblU);
            topPlaylist.Controls.Add(txtPlUrl);
            topPlaylist.Controls.Add(lblN);
            topPlaylist.Controls.Add(numPlLimit);
            topPlaylist.Controls.Add(lblTip);
            topPlaylist.Controls.Add(chkPlMeta);
            topPlaylist.Controls.Add(lblO);
            topPlaylist.Controls.Add(txtPlOut);
            topPlaylist.Controls.Add(btnPlBrowse);
            topPlaylist.Controls.Add(btnPlOpen);
            topPlaylist.Controls.Add(btnPlStart);

            tabPlaylist.Controls.Add(topPlaylist);
        }

        // ═══════════════════════════ 素材（v1.1.0）═══════════════════════════
        // Coverr 无需 key 就能用；Pixabay/Pexels 要 key（在命令行 --set-key 存一次）。
        // 场景预设是给剪辑师用的：按"城市夜景"找，比让他想英文词有用。
        void BuildStockTab()
        {
            topStock = new Panel();
            topStock.Dock = DockStyle.Top;
            topStock.Height = 168;
            topStock.Padding = new Padding(12, 8, 12, 8);
            topStock.BackColor = Color.White;

            var lblScene = new Label();
            lblScene.Text = "场景";
            lblScene.Location = new Point(14, 12);
            lblScene.AutoSize = true;

            cmbStScene = new ComboBox();
            cmbStScene.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbStScene.Location = new Point(56, 9);
            cmbStScene.Size = new Size(150, 24);
            cmbStScene.Items.AddRange(new object[] {
                "（自定义关键词）",
                "城市夜景", "城市", "自然", "山", "海", "天空",
                "办公", "科技", "咖啡", "人物", "抽象",
                "慢动作", "航拍", "美食", "运动", "雨雪"
            });
            cmbStScene.SelectedIndex = 1;

            var lblKw = new Label();
            lblKw.Text = "关键词";
            lblKw.Location = new Point(222, 12);
            lblKw.AutoSize = true;

            txtStKeyword = new TextBox();
            txtStKeyword.Location = new Point(276, 9);
            txtStKeyword.Size = new Size(300, 24);
            txtStKeyword.BorderStyle = BorderStyle.FixedSingle;
            var tipKw = new ToolTip();
            tipKw.SetToolTip(txtStKeyword, "选了具体场景时这里会被忽略；选「自定义关键词」才用它。");

            var lblSrc = new Label();
            lblSrc.Text = "素材源";
            lblSrc.Location = new Point(592, 12);
            lblSrc.AutoSize = true;

            cmbStSource = new ComboBox();
            cmbStSource.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbStSource.Location = new Point(646, 9);
            cmbStSource.Size = new Size(120, 24);
            cmbStSource.Items.AddRange(new object[] { "Coverr（免key）", "Pixabay", "Pexels" });
            cmbStSource.SelectedIndex = 0;

            var lblN = new Label();
            lblN.Text = "数量";
            lblN.Location = new Point(14, 52);
            lblN.AutoSize = true;

            numStLimit = new NumericUpDown();
            numStLimit.Location = new Point(56, 49);
            numStLimit.Size = new Size(70, 24);
            numStLimit.Minimum = 1;
            numStLimit.Maximum = 200;
            numStLimit.Value = 5;

            chkStLandscape = new CheckBox();
            chkStLandscape.Text = "只要横屏";
            chkStLandscape.Location = new Point(140, 50);
            chkStLandscape.AutoSize = true;
            chkStLandscape.Checked = true;

            var lblO = new Label();
            lblO.Text = "保存到";
            lblO.Location = new Point(14, 90);
            lblO.AutoSize = true;

            txtStOut = new TextBox();
            txtStOut.Location = new Point(72, 87);
            txtStOut.Size = new Size(800, 24);
            txtStOut.Text = Path.Combine(Application.StartupPath, "downloads", "素材");

            btnStBrowse = new Button();
            btnStBrowse.Text = "浏览…";
            btnStBrowse.Location = new Point(880, 86);
            btnStBrowse.Size = new Size(80, 26);
            btnStBrowse.Click += delegate { BrowseInto(txtStOut); };

            btnStOpen = new Button();
            btnStOpen.Text = "打开目录";
            btnStOpen.Location = new Point(968, 86);
            btnStOpen.Size = new Size(88, 26);
            btnStOpen.Click += delegate { OpenDir(txtStOut.Text); };

            btnStStart = new Button();
            btnStStart.Text = "开始下载";
            btnStStart.Location = new Point(1060, 84);
            btnStStart.Size = new Size(88, 28);
            btnStStart.Click += delegate { StartStock(); };

            var lblNote = new Label();
            lblNote.Text = "素材可免费商用（Coverr / Pixabay / Pexels），会同时存缩略图和授权说明。";
            lblNote.Location = new Point(14, 126);
            lblNote.AutoSize = true;
            lblNote.ForeColor = Color.FromArgb(120, 120, 130);
            lblNote.Font = new Font("Microsoft YaHei UI", 8.5F);

            topStock.Controls.Add(lblScene);
            topStock.Controls.Add(cmbStScene);
            topStock.Controls.Add(lblKw);
            topStock.Controls.Add(txtStKeyword);
            topStock.Controls.Add(lblSrc);
            topStock.Controls.Add(cmbStSource);
            topStock.Controls.Add(lblN);
            topStock.Controls.Add(numStLimit);
            topStock.Controls.Add(chkStLandscape);
            topStock.Controls.Add(lblO);
            topStock.Controls.Add(txtStOut);
            topStock.Controls.Add(btnStBrowse);
            topStock.Controls.Add(btnStOpen);
            topStock.Controls.Add(btnStStart);
            topStock.Controls.Add(lblNote);

            tabStock.Controls.Add(topStock);
        }

        // ═══════════════════════════ 布局 ═══════════════════════════
        // 150% DPI 下 WinForms 会把控件按 1.5 放大，但我们在代码里算的坐标是物理像素。
        // 所有"设计尺寸"常量都要过一遍 S() 换算，否则按钮会互相压住或跑出窗口。
        int S(int designUnits) { return LogicalToDeviceUnits(designUnits); }

        void LayoutVideoTop()
        {
            if (topVideo == null) return;
            int w = topVideo.ClientSize.Width;
            int pad = S(14);
            txtLinks.Width = Math.Max(S(200), w - pad * 2);

            btnBrowse.Left = w - pad - S(80);
            txtOut.Left = S(248);
            txtOut.Width = Math.Max(S(120), btnBrowse.Left - S(8) - S(248));

            int stopW = S(92), startW = S(132), openW = S(88), clearW = S(88), gap = S(8);
            int x = w - pad;
            x -= stopW; btnStop.Width = stopW; btnStop.Left = x;
            x -= gap + startW; btnStart.Width = startW; btnStart.Left = x;
            x -= gap + openW; btnOpenDir.Width = openW; btnOpenDir.Left = x;
            x -= gap + clearW; btnClear.Width = clearW; btnClear.Left = x;
            chkHeadful.Text = (chkHeadful.Right + S(12) > btnClear.Left)
                ? "显示浏览器" : "显示浏览器（过验证码用）";
        }

        void LayoutMusicTop()
        {
            if (topMusic == null) return;
            int w = topMusic.ClientSize.Width;
            int pad = S(14);

            // 第一行：搜索框自适应，按钮钉右侧
            btnMusicSearch.Left = w - pad - S(110);
            btnMusicSearch.BringToFront();
            txtMusicKey.Left = S(14);
            txtMusicKey.Width = Math.Max(S(140), btnMusicSearch.Left - S(8) - S(14));

            // 第二行右侧：目录组从右往左排
            int x = w - pad;
            btnMusicOpen.Left = x - S(88); x = btnMusicOpen.Left - S(8);
            btnMusicBrowse.Left = x - S(32); x = btnMusicBrowse.Left - S(8);
            txtMusicOut.Left = S(530);
            txtMusicOut.Width = Math.Max(S(120), x - S(530));
            btnMusicOpen.BringToFront();
            btnMusicBrowse.BringToFront();
        }

        void LayoutBottom()
        {
            if (bottom == null) return;
            int w = bottom.ClientSize.Width;
            int h = bottom.ClientSize.Height;
            int pad = S(14);
            progress.Width = Math.Max(S(200), w - pad * 2);
            txtLog.Width = Math.Max(S(200), w - pad * 2);
            txtLog.Height = Math.Max(S(60), h - txtLog.Top - S(10));
        }

        void LayoutVideoList()
        {
            if (listTasks == null || listTasks.Columns.Count < 6) return;
            int avail = listTasks.ClientSize.Width - S(28);
            int fixedSum = S(92) + S(120) + S(110) + S(80) + S(80);
            listTasks.Columns[1].Width = Math.Max(S(140), avail - fixedSum);
        }

        void LayoutMusicList()
        {
            if (listMusic == null || listMusic.Columns.Count < 7) return;
            int avail = listMusic.ClientSize.Width - S(28);
            int fixedSum = S(84) + S(190) + S(70) + S(84) + S(60) + S(76);
            listMusic.Columns[1].Width = Math.Max(S(140), avail - fixedSum);
        }

        void LayoutZhihuTop()
        {
            if (topZhihu == null) return;
            int w = topZhihu.ClientSize.Width;
            int pad = S(14);

            txtZhihuUrl.Width = Math.Max(S(200), w - pad * 2);

            // 右侧：开始/停止 上下叠放
            int btnW = S(120);
            btnZhihuStart.Left = w - pad - btnW;
            btnZhihuStop.Left = w - pad - btnW;
            btnZhihuStart.Width = btnW;
            btnZhihuStop.Width = btnW;

            // 路径行：浏览… 钉在开始按钮左边
            btnZhihuBrowse.Left = btnZhihuStart.Left - S(8) - S(80);
            txtZhihuOut.Left = S(72);
            txtZhihuOut.Width = Math.Max(S(120), btnZhihuBrowse.Left - S(8) - S(72));

            // 打开目录放到复选框行（避免与开始按钮重叠）
            btnZhihuOpen.Left = btnZhihuBrowse.Left;
            btnZhihuOpen.Top = S(118);
            btnZhihuOpen.Width = S(80);
        }

        void LayoutZhihuList()
        {
            if (listZhihu == null || listZhihu.Columns.Count < 5) return;
            int avail = listZhihu.ClientSize.Width - S(28);
            int fixedSum = S(90) + S(80) + S(70) + S(260);
            listZhihu.Columns[1].Width = Math.Max(S(160), avail - fixedSum);
        }

        // ═══════════════════════════ 公共动作 ═══════════════════════════

        /// <summary>
        /// 定位统一引擎。优先用单个「下载器.exe」，找不到再回退到分体引擎
        /// （兼容老版本的 抖音下载器.exe / 音乐下载器.exe / 知乎下载器.exe）。
        /// C# 5 不支持元组，用 out 参数返回「是否为统一引擎」。
        /// </summary>
        string FindEngine(string legacyName, out bool unified)
        {
            unified = false;

            string uni = Path.Combine(Application.StartupPath, "下载器.exe");
            if (File.Exists(uni)) { unified = true; return uni; }

            string legacy = Path.Combine(Application.StartupPath, legacyName);
            if (File.Exists(legacy)) return legacy;

            return null;
        }

        // ═══════════════════════ 激活闸门 ═══════════════════════
        // 未激活时任何功能都不给用。所有「开始」按钮点下去先过这里。
        //
        // 为什么在 UI 也要拦：
        //   引擎侧已经拦了（exit=2），但用户点按钮后只会看到日志里一行错误，
        //   体验很差。UI 侧直接弹窗说清楚，并给出「立即激活」入口。
        // 内部测试版标识：由 build-internal.cmd 编译时用 /define 注入
#if INTERNAL_BUILD
        const string InternalTag = " · 内测版";
        const string InternalVersion = AppVersionBeta;
#else
        const string InternalTag = "";
#endif
        string lastActivateOut = null;   // 上一次激活的 CLI 输出（用于显示累加提示）

        bool licenseOk = false;
        string licenseMachine = "";
        string licenseTier = "";        // 档位名（日卡/月卡/年卡/永久卡）
        string licenseExpiry = "";      // 到期日
        int licenseDaysLeft = -1;       // 剩余天数，-1 = 未知
        DateTime licenseCheckedAt = DateTime.MinValue;

        /// <summary>重新读一次激活状态（激活成功后要调用）</summary>
        bool RefreshLicense(bool force = false)
        {
            // 缓存 3 秒，避免每点一个按钮都起子进程
            if (!force && (DateTime.Now - licenseCheckedAt).TotalSeconds < 3 && licenseMachine.Length > 0)
                return licenseOk;

            string o = EngineRun("license status");
            licenseCheckedAt = DateTime.Now;

            if (o == null) { licenseOk = false; return false; }

            licenseOk = o.Contains("已激活");
            int i = o.IndexOf("机器码:");
            if (i >= 0)
            {
                string rest = o.Substring(i + 4).Trim();
                int nl = rest.IndexOf('\n');
                licenseMachine = (nl > 0 ? rest.Substring(0, nl) : rest).Trim();
            }

            // 档位: 日卡 / 周卡 / 月卡 / 季卡 / 年卡 / 永久卡
            licenseTier = "";
            int ti = o.IndexOf("档位");
            if (ti >= 0)
            {
                int colon = o.IndexOf(':', ti);
                if (colon < 0) colon = o.IndexOf('：', ti);
                if (colon >= 0)
                {
                    string rest = o.Substring(colon + 1).Trim();
                    int nl = rest.IndexOf('\n');
                    licenseTier = (nl > 0 ? rest.Substring(0, nl) : rest).Trim();
                }
            }

            // 到期: 2027-10-25 （剩 366 天）
            licenseExpiry = "";
            licenseDaysLeft = -1;
            int ei = o.IndexOf("到期");
            if (ei >= 0)
            {
                int colon = o.IndexOf(':', ei);
                if (colon < 0) colon = o.IndexOf('：', ei);
                if (colon >= 0)
                {
                    string rest = o.Substring(colon + 1).Trim();
                    int nl = rest.IndexOf('\n');
                    string line = (nl > 0 ? rest.Substring(0, nl) : rest).Trim();
                    licenseExpiry = line;
                    int dls = line.IndexOf("剩 ");
                    if (dls >= 0)
                    {
                        int ds = dls + 2, de = ds;
                        while (de < line.Length && char.IsDigit(line[de])) de++;
                        if (de > ds)
                        {
                            int.TryParse(line.Substring(ds, de - ds), out licenseDaysLeft);
                        }
                    }
                }
            }

            return licenseOk;
        }

        /// <summary>功能入口守卫。返回 false 表示未激活，已弹窗引导。</summary>
        bool RequireLicense(string featureName)
        {
            // 开源免费版：所有功能无条件放行。
            // 保留这个方法签名是为了不改 8 个页面的调用点 —— 将来若有人
            // fork 出去做收费版，只改这里一行就能恢复校验。
            return true;
#if INTERNAL_BUILD
            // 内部测试版：完全跳过授权检查。
            // 注意自检旁路也只在内部版生效 —— 见下面 #else 分支的说明。
            return true;
#else
            // ⚠ 发布版：自检入口本身不开放，所以这里**不再**为 selfTest 放行。
            //   旧代码是 `if (selfTest != null) return true;`，而 --selftest
            //   是命令行参数，任何用户都能加：
            //       下载器UI.exe --selftest music "雨爱" out.txt
            //   等于白送一个"一键免激活"的开关（引擎侧 DSH_DL_SELFTEST 同理，
            //   已在 cli.mjs 里改成只在内部版生效）。
            if (RefreshLicense()) return true;

            var r = MsgBox(
                "软件未激活，无法使用「" + featureName + "」。\n\n" +
                "本机机器码: " + (licenseMachine.Length > 0 ? licenseMachine : "（读取失败）") + "\n\n" +
                "请把机器码发给卖家换取激活码，然后点击「立即激活」。",
                "需要激活", MessageBoxButtons.OKCancel);
            // OK → 引导去激活；Cancel → 什么都不做
            if (r == DialogResult.OK) DoActivate();
            return false;
#endif
        }

        /// <summary>
        /// 大小写不敏感地设置子进程环境变量。
        ///
        /// Windows 的环境变量字典不区分大小写，但 .NET 的 StringDictionary
        /// 在校验重复键时会对 NO_PROXY / no_proxy 这类同时存在的键抛异常。
        /// 先按不区分大小写删掉所有同名键，再写入。
        /// </summary>
        void BrowseInto(TextBox target)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择保存位置";
                if (Directory.Exists(target.Text)) dlg.SelectedPath = target.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK) target.Text = dlg.SelectedPath;
            }
        }

        void OpenDir(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
            catch (Exception ex) { Log("[错误] 打开目录失败: " + ex.Message); }
        }

        void Log(string s)
        {
            // 同时落盘一份，方便排查（窗口不方便看时直接读文件）
            try
            {
                string logDir = Path.Combine(Application.StartupPath, "logs");
                if (!Directory.Exists(logDir)) Directory.CreateDirectory(logDir);
                File.AppendAllText(
                    Path.Combine(logDir, "ui-" + DateTime.Now.ToString("yyyyMMdd") + ".log"),
                    DateTime.Now.ToString("HH:mm:ss") + "  " + s + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch { }

            if (txtLog == null || txtLog.IsDisposed) return;
            if (txtLog.TextLength > 400000) txtLog.Clear();
            txtLog.AppendText(s + Environment.NewLine);
            txtLog.SelectionStart = txtLog.TextLength;
            txtLog.ScrollToCaret();
        }

        static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }

        /// <summary>
        /// 从输入框抽出抖音链接，每条单独 Quote，避免多行整段当一个参数被 Windows 截断。
        /// 抽不到链接时退回「去换行后的整段分享文案」。
        /// </summary>
        static string BuildDouyinUrlArgs(string raw)
        {
            var urls = new List<string>();
            foreach (Match m in Regex.Matches(raw ?? "", @"https?://[^\s""'<>，。、；）)]+", RegexOptions.IgnoreCase))
            {
                string glued = m.Value.TrimEnd('.', ',', ';', ')');
                foreach (string piece in Regex.Split(glued, @"(?=https?://)", RegexOptions.IgnoreCase))
                {
                    if (string.IsNullOrEmpty(piece)) continue;
                    string u = piece.TrimEnd('.', ',', ';', ')');
                    if (u.IndexOf("douyin.com", StringComparison.OrdinalIgnoreCase) < 0 &&
                        u.IndexOf("iesdouyin.com", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;
                    if (!urls.Contains(u)) urls.Add(u);
                }
            }
            if (urls.Count > 0)
            {
                var sb = new StringBuilder();
                for (int i = 0; i < urls.Count; i++)
                {
                    if (i > 0) sb.Append(' ');
                    sb.Append(Quote(urls[i]));
                }
                return sb.ToString();
            }
            string blob = Regex.Replace(raw ?? "", @"\s+", " ").Trim();
            return Quote(blob);
        }

        static string FmtSize(long b)
        {
            if (b <= 0) return "-";
            if (b > 1024L * 1024 * 1024) return (b / 1024.0 / 1024 / 1024).ToString("0.00") + " GB";
            if (b > 1024L * 1024) return (b / 1024.0 / 1024).ToString("0.00") + " MB";
            return (b / 1024.0).ToString("0") + " KB";
        }

        static string SafeName(string s)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace('"', '_').Replace('<', '_').Replace('>', '_').Replace('|', '_');
            return s.Trim().Length > 0 ? s.Trim() : "music";
        }

        // ═══════════════════════════ 抖音流程 ═══════════════════════════
        string QualityFlag()
        {
            switch (cmbQuality.SelectedIndex)
            {
                case 1: return "4k";
                case 2: return "1440";
                case 3: return "1080";
                case 4: return "720";
                case 5: return "540";
                default: return "best";
            }
        }

        void ClearList()
        {
            if (engine != null) { MsgBox(this, "请先停止当前任务", "提示"); return; }
            listTasks.Items.Clear();
            jobs.Clear();
            current = null;
            progress.Value = 0;
            txtLog.Clear();
        }

        void StartDownload()
        {
            if (!RequireLicense("抖音视频")) return;
            if (engine != null) return;
            string raw = txtLinks.Text.Trim();
            if (raw.Length == 0)
            {
                MsgBox(this, "请先粘贴抖音链接或分享文案", "提示");
                txtLinks.Focus();
                return;
            }
            bool uniV;
            string eng = FindEngine("抖音下载器.exe", out uniV);
            if (eng == null)
            {
                MsgBox(this,
                    "找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。",
                    "缺少引擎", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string outDir = txtOut.Text.Trim();
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex)
            {
                MsgBox(this, "无法创建输出目录:\n" + ex.Message, "错误");
                return;
            }

            var psi = new ProcessStartInfo();
            psi.FileName = eng;
            string videoArgs = BuildDouyinUrlArgs(raw) + " -o " + Quote(outDir) + " -q " + QualityFlag()
                + (chkAudio.Checked ? " --audio" : "")
                + (chkHeadful.Checked ? " --headful" : "");
            psi.Arguments = uniV ? "video " + videoArgs : videoArgs;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;
            // 自检模式下告诉引擎跳过激活闸门（否则回归测试全被拦）
            // 自检旁路已通过进程级环境变量设置（见 BeginSelfTest），子进程自动继承

            try
            {
                engine = new Process();
                engine.StartInfo = psi;
                engine.Start();
                stopping = false;
                btnStart.Enabled = false;
                btnStop.Enabled = true;
                progress.Value = 0;
                statusLabel.Text = "抖音下载中…";
                Log("━━━ 开始 ━━━");
                Log("引擎: " + eng);
                Log("");
                reader = new Thread(ReadVideoLoop);
                reader.IsBackground = true;
                reader.Start(engine);
            }
            catch (Exception ex)
            {
                Log("[错误] 启动失败: " + ex.Message);
                CleanupVideo();
                MsgBox(this, "启动引擎失败:\n" + ex.Message, "错误");
            }
        }

        void StopDownload()
        {
            if (engine == null) return;
            stopping = true;
            btnStop.Enabled = false;
            statusLabel.Text = "正在停止…";
            Log("");
            Log("[停止] 正在终止…");
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + engine.Id + " /T /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process.Start(psi);
            }
            catch { try { engine.Kill(); } catch { } }
            CleanupVideo();
        }

        void ReadVideoLoop(object obj)
        {
            Process p = (Process)obj;
            var sb = new StringBuilder();

            Thread t2 = new Thread(delegate ()
            {
                try
                {
                    string line;
                    while ((line = p.StandardError.ReadLine()) != null) PostVideo(line);
                }
                catch { }
            });
            t2.IsBackground = true;
            t2.Start();

            try
            {
                var sr = p.StandardOutput;
                int ch;
                while ((ch = sr.Read()) != -1)
                {
                    if (ch == '\r' || ch == '\n')
                    {
                        if (sb.Length > 0) { PostVideo(sb.ToString()); sb.Length = 0; }
                    }
                    else sb.Append((char)ch);
                }
                if (sb.Length > 0) PostVideo(sb.ToString());
            }
            catch { }

            try { p.WaitForExit(); } catch { }

            BeginInvoke((MethodInvoker)delegate
            {
                int code = -1;
                try { code = p.ExitCode; } catch { }
                Log("");
                if (stopping) Log("━━━ 已手动停止 ━━━");
                else if (code == 0) Log("━━━ 全部完成 ━━━");
                else Log("━━━ 结束（退出码 " + code + "，有失败项）━━━");
                FinishAll(stopping);
                CleanupVideo();
            });
        }

        void PostVideo(string line)
        {
            try { BeginInvoke((MethodInvoker)delegate { HandleVideoLine(line); }); } catch { }
        }

        void HandleVideoLine(string raw)
        {
            string line = raw.TrimEnd();
            if (line.Length == 0) return;

            if (line.Contains("下载 ") && line.Contains("%"))
            {
                int pct = ExtractPercent(line);
                if (pct >= 0) { try { progress.Value = Math.Min(100, pct); } catch { } }
                if (current != null && !current.Failed) SetCell(current, 0, "下载中 " + pct + "%");
                return;
            }

            Log(line);

            if (line.Contains("汇总"))
            {
                if (current != null) CompleteJob(current);
                foreach (Job j in jobs) CompleteJob(j);
                progress.Value = 100;
                return;
            }

            if (line.Contains("━━━ 处理:"))
            {
                if (current != null && !current.Finished) CompleteJob(current);
                string url = line.Substring(line.IndexOf("处理:") + 3).Trim();
                current = NewJob(url);
                return;
            }

            if (current == null) return;

            if (line.Contains("标题:")) { current.Title = After(line, "标题:"); SetCell(current, 1, current.Title); }
            else if (line.Contains("类型:"))
            {
                string t = After(line, "类型:");
                SetCell(current, 2, t);
                if (t.StartsWith("图文")) SetCell(current, 3, "原图");
            }
            else if (line.Contains("选定:")) { current.Quality = After(line, "选定:"); SetCell(current, 3, current.Quality); }
            else if (line.Contains("✓"))
            {
                current.FileCount++;
                SetCell(current, 4, current.FileCount + " 个");
                long b = ExtractSize(line);
                if (b > 0) current.Bytes += b;
                if (current.Bytes > 0) SetCell(current, 5, FmtSize(current.Bytes));
            }
            else if (line.Contains("✗") || line.Contains("失败") || line.Contains("[致命]"))
            {
                current.Failed = true;
                SetCell(current, 0, "失败");
            }
        }

        static string After(string s, string key)
        {
            int i = s.IndexOf(key);
            return i < 0 ? s.Trim() : s.Substring(i + key.Length).Trim();
        }

        static int ExtractPercent(string s)
        {
            int i = s.IndexOf('%');
            if (i <= 0) return -1;
            int j = i - 1;
            while (j >= 0 && (char.IsDigit(s[j]) || s[j] == ' ')) j--;
            int v;
            return int.TryParse(s.Substring(j + 1, i - j - 1).Trim(), out v) ? v : -1;
        }

        static long ExtractSize(string s)
        {
            int i = s.LastIndexOf('(');
            while (i >= 0)
            {
                int j = s.IndexOf(')', i);
                if (j > i)
                {
                    string[] parts = s.Substring(i + 1, j - i - 1).Trim().Split(' ');
                    if (parts.Length >= 2)
                    {
                        double num;
                        if (double.TryParse(parts[0], System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out num))
                        {
                            string u = parts[1].ToUpperInvariant();
                            if (u == "GB") return (long)(num * 1024 * 1024 * 1024);
                            if (u == "MB") return (long)(num * 1024 * 1024);
                            if (u == "KB") return (long)(num * 1024);
                            if (u == "B") return (long)num;
                        }
                    }
                }
                i = s.LastIndexOf('(', i - 1);
            }
            return 0;
        }

        Job NewJob(string url)
        {
            var j = new Job();
            j.Url = url;
            var it = new ListViewItem(new string[] { "解析中…", "", "", "", "", "" });
            j.Row = it;
            listTasks.Items.Add(it);
            it.EnsureVisible();
            jobs.Add(j);
            return j;
        }

        void SetCell(Job j, int col, string text)
        {
            if (j == null || j.Row == null) return;
            if (col < j.Row.SubItems.Count) j.Row.SubItems[col].Text = text;
        }

        void CompleteJob(Job j)
        {
            if (j == null || j.Finished) return;
            j.Finished = true;
            if (!j.Failed) SetCell(j, 0, "完成");
        }

        void FinishAll(bool aborted)
        {
            foreach (Job j in jobs)
            {
                if (j.Finished || j.Failed) continue;
                if (aborted) SetCell(j, 0, "已停止");
                else CompleteJob(j);
            }
            if (!aborted) progress.Value = 100;
        }

        void CleanupVideo()
        {
            try { if (engine != null) engine.Dispose(); } catch { }
            engine = null;
            btnStart.Enabled = true;
            btnStop.Enabled = false;
            statusLabel.Text = "就绪";
        }

        // ═══════════════════════════ 音乐流程 ═══════════════════════════
        void SearchMusic()
        {
            if (!RequireLicense("音乐搜索")) return;
            if (musicProc != null) { MsgBox(this, "搜索进行中，请稍等", "提示"); return; }
            string kw = txtMusicKey.Text.Trim();
            if (kw.Length == 0) { MsgBox(this, "请输入歌名或歌手", "提示"); txtMusicKey.Focus(); return; }

            bool uniM;
            string eng = FindEngine("音乐下载器.exe", out uniM);
            if (eng == null)
            {
                MsgBox(this,
                    "找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。",
                    "缺少引擎", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            listMusic.Items.Clear();
            tracks.Clear();
            btnMusicSearch.Enabled = false;
            btnMusicBest.Enabled = false;
            btnMusicDownload.Enabled = false;
            progress.Value = 20;
            statusLabel.Text = "搜索中…";
            Log("");
            Log("━━━ 音乐搜索: " + kw + " ━━━");

            var psi = new ProcessStartInfo();
            psi.FileName = eng;
            string mArgs = "search " + Quote(kw) + " --limit " + ((int)numLimit.Value) + " --jsononly";
            // 过滤条件：勾选的格式 + 码率阈值
            var fmts = new System.Collections.Generic.List<string>();
            if (chkFmtMp3.Checked) fmts.Add("mp3");
            if (chkFmtM4a.Checked) fmts.Add("m4a");
            if (chkFmtFlac.Checked) fmts.Add("flac");
            if (fmts.Count > 0) mArgs += " --format " + string.Join(",", fmts);
            int[] kbpsMap = { 0, 64, 128, 192, 256, 320 };
            int minK = kbpsMap[Math.Max(0, Math.Min(kbpsMap.Length - 1, cmbMinKbps.SelectedIndex))];
            if (minK > 0) mArgs += " --min-kbps " + minK;
            psi.Arguments = uniM ? "music " + mArgs : mArgs;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;
            // 自检模式下告诉引擎跳过激活闸门（否则回归测试全被拦）
            // 自检旁路已通过进程级环境变量设置（见 BeginSelfTest），子进程自动继承

            var proc = new Process();
            proc.StartInfo = psi;
            musicProc = proc;
            proc.Start();

            // 进度条别停在 20% 给人「卡住」的错觉：搜索期间缓慢爬升到 90，
            // 结果回来再收尾。旧版是 20 → 0 两跳，中间完全不动。
            musicSearchAt = DateTime.Now;
            if (musicWatch != null) { musicWatch.Stop(); musicWatch.Dispose(); }
            musicWatch = new System.Windows.Forms.Timer();
            musicWatch.Interval = 400;
            musicWatch.Tick += delegate
            {
                if (musicProc == null) return;
                double sec = (DateTime.Now - musicSearchAt).TotalSeconds;
                int pct = 20 + (int)Math.Min(70, sec * 6);   // 20% 起，最多爬到 90%
                try { if (pct > progress.Value) progress.Value = Math.Min(90, pct); } catch { }
                statusLabel.Text = "搜索中…  已等待 " + (int)sec + " 秒";
            };
            musicWatch.Start();

            Thread t = new Thread(delegate ()
            {
                string outText = "";
                string errText = "";
                // 必须**并行**读两个流。
                // 顺序 ReadToEnd(stdout) → ReadToEnd(stderr) 是经典死锁：
                // 子进程往 stderr 写满管道缓冲区（4KB）就会阻塞，
                // 而主线程还卡在 stdout 的 ReadToEnd 上等 EOF —— 双向等待。
                // 音乐搜索的进度条正好走 stderr，网络慢时很容易触发。
                Thread errReader = new Thread(delegate ()
                {
                    try { errText = proc.StandardError.ReadToEnd(); } catch { }
                });
                errReader.IsBackground = true;
                errReader.Start();
                try { outText = proc.StandardOutput.ReadToEnd(); } catch { }
                try { proc.WaitForExit(); } catch { }
                try { errReader.Join(2000); } catch { }

                int exitCode = -1;
                try { exitCode = proc.ExitCode; } catch { }

                BeginInvoke((MethodInvoker)delegate
                {
                    if (musicWatch != null) { musicWatch.Stop(); musicWatch.Dispose(); musicWatch = null; }
                    musicProc = null;
                    btnMusicSearch.Enabled = true;
                    statusLabel.Text = "就绪";

                    if (errText.Trim().Length > 0) Log(errText.Trim());

                    // 退出码 2 = 引擎的激活闸门。旧版不看退出码，一律报
                    // 「引擎无输出」——用户明明看到一段「软件未激活」的中文提示，
                    // 却被告诉"引擎无输出"，等于把人往错误方向带（日志里踩过）。
                    if (exitCode == 2)
                    {
                        progress.Value = 0;
                        Log("[未激活] 引擎拒绝执行（exit=2），请先激活");
                        RefreshLicense(true);
                        UpdateLicenseUi();
                        MsgBox(this,
                            "软件未激活，无法使用「音乐搜索」。\n\n" +
                            "本机机器码: " + (licenseMachine.Length > 0 ? licenseMachine : "（读取失败）") + "\n\n" +
                            "请把机器码发给卖家换取激活码，然后点击「立即激活」。",
                            "需要激活", MessageBoxButtons.OKCancel);
                        return;
                    }

                    if (outText.Trim().Length == 0)
                    {
                        progress.Value = 0;
                        Log("[错误] 引擎无输出（exit=" + exitCode + "）");
                        MsgBox(this, "搜索失败：引擎没有返回结果\n\n退出码: " + exitCode
                            + (errText.Trim().Length > 0 ? "\n详情见日志区" : ""), "错误");
                        return;
                    }
                    try
                    {
                        FillMusicList(outText);
                        // 搜索成功就把进度条走满，别退回 0（旧版就在这儿看着像失败）
                        progress.Value = 100;
                    }
                    catch (Exception ex)
                    {
                        progress.Value = 0;
                        Log("[错误] 解析结果失败: " + ex.Message);
                        MsgBox(this, "解析结果失败:\n" + ex.Message, "错误");
                    }
                });
            });
            t.IsBackground = true;
            t.Start();
        }

        void FillMusicList(string json)
        {
            var ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            var root = ser.Deserialize<Dictionary<string, object>>(json);
            object arrObj;
            if (root == null || !root.TryGetValue("resolved", out arrObj) || arrObj == null)
            {
                Log("[错误] 返回数据缺少 resolved 字段");
                return;
            }

            var arr = arrObj as System.Collections.IEnumerable;
            if (arr == null)
            {
                Log("[错误] resolved 类型异常: " + arrObj.GetType().FullName);
                return;
            }

            int okCount = 0, total = 0, filteredCount = 0;
            foreach (var item in arr)
            {
                var d = item as Dictionary<string, object>;
                if (d == null) continue;
                total++;

                var t = new MusicTrack();
                t.Platform = Str(d, "platform");
                t.PlatformName = Str(d, "platformName");
                t.Title = Str(d, "title");
                t.Artist = Str(d, "artist");
                t.Album = Str(d, "album");
                t.Duration = Str(d, "duration");
                t.Ok = Bool(d, "ok");
                t.Url = Str(d, "url");
                t.Referer = Str(d, "referer");
                t.Ext = Str(d, "ext"); if (t.Ext.Length == 0) t.Ext = "mp3";
                t.Size = Long(d, "size");
                t.Best = Bool(d, "best");
                t.Error = Str(d, "error");
                t.PreviewUrl = Str(d, "previewUrl");
                t.PreviewExt = Str(d, "previewExt"); if (t.PreviewExt.Length == 0) t.PreviewExt = t.Ext;
                t.PreviewSize = Long(d, "previewSize");
                t.PreviewDur = Dbl(d, "previewDur");
                // 引擎会把「不符合格式/码率条件」的条目标成 filtered 并给出原因。
                // 旧版 UI 完全忽略这两个字段，于是勾了「只要 M4A / ≥128kbps」之后，
                // 列表里仍然显示一堆「可用」的 MP3，点下载才失败 —— 等于过滤没生效。
                t.Filtered = Bool(d, "filtered");
                t.FilterReason = Str(d, "filterReason");
                if (t.Ok && !t.Filtered) okCount++;
                if (t.Filtered) filteredCount++;

                string state;
                if (!t.Ok) state = "受限";
                else if (t.Filtered) state = "不符合条件";
                else state = "可用";

                var it = new ListViewItem(new string[] {
                    t.PlatformName,
                    t.Title,
                    t.Artist,
                    state,
                    t.Ok ? FmtSize(t.Size) : "-",
                    t.Ok ? t.Ext.ToUpperInvariant() : "-",
                    t.Best ? "★ 最优" : (t.Filtered ? "已筛除" : "")
                });
                if (t.Best) it.BackColor = Color.FromArgb(232, 248, 238);
                if (!t.Ok) it.ForeColor = Color.FromArgb(150, 150, 155);
                else if (t.Filtered) it.ForeColor = Color.FromArgb(190, 130, 60);
                if (t.Filtered && t.FilterReason.Length > 0) it.ToolTipText = t.FilterReason;
                it.Tag = t;
                t.Row = it;
                listMusic.Items.Add(it);
                tracks.Add(t);
            }

            int bestCount = 0;
            foreach (var t in tracks) if (t.Best) bestCount++;

            string msg = "共 " + total + " 条，可用 " + okCount + " 条，最优 " + bestCount + " 首";
            if (filteredCount > 0) msg += "，按条件筛除 " + filteredCount + " 条";
            Log(msg);
            statusLabel.Text = "搜索完成：可用 " + okCount + "/" + total;
            btnMusicBest.Enabled = bestCount > 0;
            btnMusicDownload.Enabled = okCount > 0;

            // 默认选中第一条最优
            foreach (ListViewItem it in listMusic.Items)
            {
                var t = it.Tag as MusicTrack;
                if (t != null && t.Best) { it.Selected = true; it.EnsureVisible(); break; }
            }
        }

        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : "";
        }

        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return false;
            if (v is bool) return (bool)v;
            bool b;
            return bool.TryParse(Convert.ToString(v), out b) && b;
        }

        static long Long(Dictionary<string, object> d, string k)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return 0;
            long l;
            if (long.TryParse(Convert.ToString(v), out l)) return l;
            return 0;
        }

        static double Dbl(Dictionary<string, object> d, string k)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return 0;
            double x;
            if (double.TryParse(Convert.ToString(v), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out x)) return x;
            return 0;
        }

        void DownloadBestMusic()
        {
            // 全局最优 = 可用、未被条件筛掉、体积最大（体积≈码率≈音质）
            MusicTrack best = null;
            foreach (var t in tracks)
            {
                if (!t.Ok || t.Filtered) continue;
                if (best == null || t.Size > best.Size) best = t;
            }
            if (best == null) { MsgBox(this, "没有可下载的结果", "提示"); return; }
            StartMusicDownload(best);
        }

        void DownloadSelectedMusic()
        {
            if (listMusic.SelectedItems.Count == 0)
            {
                MsgBox(this, "请先在列表里选一条", "提示");
                return;
            }
            var t = listMusic.SelectedItems[0].Tag as MusicTrack;
            if (t == null) return;
            if (!t.Ok)
            {
                MsgBox(this, "这条不可用：" + t.Error, "提示");
                return;
            }
            if (t.Filtered)
            {
                MsgBox(this,
                    "这条不符合你设的过滤条件：\n" + t.FilterReason + "\n\n" +
                    "要下载它，请放宽「格式 / 最低码率」条件后重新搜索。",
                    "不符合条件", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            StartMusicDownload(t);
        }

        /// <summary>
        /// 试听：把音源拉到临时目录，用系统默认播放器打开。
        /// 平台若给的是完整音源（酷我实测 s=30 不生效），会提示一句。
        /// </summary>
        async void PreviewSelectedMusic()
        {
            if (listMusic.SelectedItems.Count == 0)
            {
                MsgBox(this, "请先在列表里选一条", "提示");
                return;
            }
            var t = listMusic.SelectedItems[0].Tag as MusicTrack;
            if (t == null) return;
            if (!t.Ok)
            {
                MsgBox(this, "这条不可用：" + t.Error, "提示");
                return;
            }

            string url = string.IsNullOrEmpty(t.PreviewUrl) ? t.Url : t.PreviewUrl;
            string ext = string.IsNullOrEmpty(t.PreviewExt) ? t.Ext : t.PreviewExt;
            if (string.IsNullOrEmpty(url))
            {
                MsgBox(this, "这条没有可播放的地址", "提示");
                return;
            }

            btnMusicPreview.Enabled = false;
            statusLabel.Text = "试听准备中…";
            Log("");
            Log("━━━ 试听: " + t.Title + " - " + t.Artist + "  [" + t.PlatformName + "] ━━━");

            try
            {
                string dir = Path.Combine(Path.GetTempPath(), "music-preview");
                Directory.CreateDirectory(dir);
                // 用标题+歌手+平台做键，避免不同平台同曲互相覆盖
                string dest = Path.Combine(dir,
                    SafeName(t.Title + " - " + t.Artist + " [" + t.Platform + "]") + "." + ext);

                long total = t.PreviewSize > 0 ? t.PreviewSize : t.Size;
                using (var http = new HttpClient())
                {
                    http.Timeout = TimeSpan.FromMinutes(2);
                    http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
                    if (!string.IsNullOrEmpty(t.Referer))
                        http.DefaultRequestHeaders.TryAddWithoutValidation("Referer", t.Referer);

                    // 酷我给的片段是 http:// 地址，部分环境会被 .NET 拒绝；
                    // 先试原始地址，失败再试 https 版本
                    byte[] data = null;
                    Exception lastEx = null;
                    string[] tries = new string[] { url };
                    if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                        tries = new string[] { url, "https://" + url.Substring(7) };

                    foreach (var u in tries)
                    {
                        try
                        {
                            using (var resp = await http.GetAsync(u, HttpCompletionOption.ResponseHeadersRead))
                            {
                                resp.EnsureSuccessStatusCode();
                                long cl = resp.Content.Headers.ContentLength ?? total;
                                using (var src = await resp.Content.ReadAsStreamAsync())
                                using (var ms = new MemoryStream())
                                {
                                    var buf = new byte[81920];
                                    long got = 0;
                                    int n;
                                    while ((n = await src.ReadAsync(buf, 0, buf.Length)) > 0)
                                    {
                                        ms.Write(buf, 0, n);
                                        got += n;
                                        if (cl > 0)
                                        {
                                            int pct = (int)Math.Min(100, got * 100 / cl);
                                            progress.Value = pct;
                                            statusLabel.Text = "试听加载 " + pct + "%";
                                        }
                                    }
                                    data = ms.ToArray();
                                }
                            }
                            lastEx = null;
                            break;
                        }
                        catch (Exception ex)
                        {
                            lastEx = ex;
                        }
                    }
                    if (data == null) throw lastEx ?? new Exception("下载失败");
                    File.WriteAllBytes(dest, data);
                }

                progress.Value = 100;
                var fi = new FileInfo(dest);
                Log("  ✓ " + fi.Name + " (" + FmtSize(fi.Length) + ")");

                if (t.PreviewDur > 0 && t.PreviewDur < 60)
                {
                    Log("  片段时长 " + t.PreviewDur.ToString("0.0") + " 秒（平台试听片段）");
                }
                else if (t.PreviewDur > 0)
                {
                    Log("  平台未提供片段，这是完整音源（" + t.PreviewDur.ToString("0") + " 秒）");
                }

                // 用系统默认播放器打开
                Process.Start(new ProcessStartInfo(dest) { UseShellExecute = true });
                statusLabel.Text = "试听中（外部播放器）";
            }
            catch (Exception ex)
            {
                progress.Value = 0;
                statusLabel.Text = "试听失败";
                Log("  ✗ " + ex.Message);
                MsgBox(this, "试听失败:\n" + ex.Message, "错误");
            }
            finally
            {
                btnMusicPreview.Enabled = true;
            }
        }

        async void StartMusicDownload(MusicTrack t)
        {
            string dir = txtMusicOut.Text.Trim();
            try { if (!Directory.Exists(dir)) Directory.CreateDirectory(dir); }
            catch (Exception ex) { MsgBox(this, "无法创建目录:\n" + ex.Message, "错误"); return; }

            string dest = Path.Combine(dir, SafeName(t.Title + " - " + t.Artist) + "." + t.Ext);
            if (File.Exists(dest))
            {
                var r = MsgBox(this, "文件已存在，覆盖？\n" + Path.GetFileName(dest), "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes) return;
            }

            btnMusicBest.Enabled = false;
            btnMusicDownload.Enabled = false;
            progress.Value = 0;
            statusLabel.Text = "下载中…";
            Log("");
            Log("━━━ 下载: " + t.Title + " - " + t.Artist + "  [" + t.PlatformName + " " + FmtSize(t.Size) + "] ━━━");

            try
            {
                using (var http = new HttpClient())
                {
                    http.Timeout = TimeSpan.FromMinutes(5);
                    http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
                    if (!string.IsNullOrEmpty(t.Referer))
                        http.DefaultRequestHeaders.TryAddWithoutValidation("Referer", t.Referer);

                    using (var resp = await http.GetAsync(t.Url, HttpCompletionOption.ResponseHeadersRead))
                    {
                        resp.EnsureSuccessStatusCode();
                        long total = resp.Content.Headers.ContentLength ?? t.Size;
                        using (var src = await resp.Content.ReadAsStreamAsync())
                        using (var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            var buf = new byte[81920];
                            long got = 0;
                            int n;
                            while ((n = await src.ReadAsync(buf, 0, buf.Length)) > 0)
                            {
                                await fs.WriteAsync(buf, 0, n);
                                got += n;
                                if (total > 0)
                                {
                                    int pct = (int)Math.Min(100, got * 100 / total);
                                    progress.Value = pct;
                                    statusLabel.Text = "下载中 " + pct + "%  " + FmtSize(got) + "/" + FmtSize(total);
                                }
                            }
                            if (total > 0 && got != total)
                                throw new Exception("下载不完整 " + FmtSize(got) + "/" + FmtSize(total));
                        }
                    }
                }
                progress.Value = 100;
                statusLabel.Text = "完成";
                Log("  ✓ " + Path.GetFileName(dest) + " (" + FmtSize(new FileInfo(dest).Length) + ")");
                Log("  保存到: " + dest);
            }
            catch (Exception ex)
            {
                progress.Value = 0;
                statusLabel.Text = "下载失败";
                Log("  ✗ 失败: " + ex.Message);
                MsgBox(this, "下载失败:\n" + ex.Message, "错误");
            }
            finally
            {
                btnMusicBest.Enabled = true;
                btnMusicDownload.Enabled = true;
            }
        }

        // ═══════════════════════════ 站点视频流程 ═══════════════════════════
        string SiteQualityFlag()
        {
            switch (cmbSiteQuality.SelectedIndex)
            {
                case 1: return "4k";
                case 2: return "1440";
                case 3: return "1080";
                case 4: return "720";
                case 5: return "480";
                case 6: return "360";
                default: return "best";
            }
        }

        void StartSites()
        {
            if (!RequireLicense("站点视频")) return;
            if (siteProc != null) { MsgBox("任务进行中，请稍等", "提示"); return; }

            string raw = txtSiteUrl.Text.Trim();
            if (raw.Length == 0)
            {
                MsgBox("请先粘贴视频链接", "提示");
                txtSiteUrl.Focus();
                return;
            }

            bool uniS;
            string eng = FindEngine("视频下载器.exe", out uniS);
            if (eng == null)
            {
                MsgBox("找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。", "缺少引擎");
                return;
            }

            string outDir = txtSiteOut.Text.Trim();
            if (outDir.Length == 0)
            {
                outDir = Path.Combine(Application.StartupPath, "downloads", "视频");
                txtSiteOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgBox("无法创建目录:\n" + ex.Message, "错误"); return; }

            listSites.Items.Clear();
            siteJobs.Clear();
            btnSiteStart.Enabled = false;
            progress.Value = 10;
            statusLabel.Text = "站点视频下载中…";
            Log("");
            Log("━━━ 站点视频 ━━━");

            var psi = new ProcessStartInfo();
            psi.FileName = eng;
            string args = Quote(raw) + " -o " + Quote(outDir) + " -q " + SiteQualityFlag();
            if (chkSiteSubs.Checked) args += " --subs";
            if (chkSiteAllParts.Checked) args += " --all-parts";
            string ck = txtSiteCookieBrowser.Text.Trim();
            if (ck.Length > 0) args += " --cookies-from " + ck;
            psi.Arguments = uniS ? "sites " + args : args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;
            // 自检模式下告诉引擎跳过激活闸门（否则回归测试全被拦）
            // 自检旁路已通过进程级环境变量设置（见 BeginSelfTest），子进程自动继承

            try
            {
                var p = new Process();
                p.StartInfo = psi;
                siteProc = p;
                p.Start();

                siteStartAt = DateTime.Now;
                if (siteWatch != null) { siteWatch.Stop(); siteWatch.Dispose(); }
                siteWatch = new System.Windows.Forms.Timer();
                siteWatch.Interval = 500;
                siteWatch.Tick += delegate
                {
                    if (siteProc == null) return;
                    double sec = (DateTime.Now - siteStartAt).TotalSeconds;
                    int pct = 10 + (int)Math.Min(80, sec * 2.5);
                    try { if (pct > progress.Value) progress.Value = Math.Min(90, pct); } catch { }
                    if (sec > 8) statusLabel.Text = "下载中…  已等待 " + (int)sec + " 秒";
                };
                siteWatch.Start();

                Thread t = new Thread(delegate ()
                {
                    try
                    {
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null) PostSite(line);
                    }
                    catch { }
                    try
                    {
                        string eline;
                        while ((eline = p.StandardError.ReadLine()) != null) PostSite(eline);
                    }
                    catch { }
                    try { p.WaitForExit(); } catch { }

                    BeginInvoke((MethodInvoker)delegate
                    {
                        int code = -1;
                        try { code = p.ExitCode; } catch { }
                        if (siteWatch != null) { siteWatch.Stop(); siteWatch.Dispose(); siteWatch = null; }
                        siteProc = null;
                        btnSiteStart.Enabled = true;
                        statusLabel.Text = code == 0 ? "完成" : "结束（有失败）";
                        if (code != 0) AutoReport("sites-fail", "站点视频退出码 " + code, "");
                        progress.Value = code == 0 ? 100 : 0;
                        Log("");
                        Log(code == 0 ? "━━━ 全部完成 ━━━" : "━━━ 结束（退出码 " + code + "）━━━");
                        foreach (var j in siteJobs)
                        {
                            if (!j.Failed && !j.Finished) { j.Finished = true; SetSiteCell(j, 0, "完成"); }
                        }
                        try { p.Dispose(); } catch { }
                    });
                });
                t.IsBackground = true;
                t.Start();
            }
            catch (Exception ex)
            {
                siteProc = null;
                btnSiteStart.Enabled = true;
                Log("[错误] 启动失败: " + ex.Message);
                MsgBox("启动引擎失败:\n" + ex.Message, "错误");
            }
        }

        void StopSites()
        {
            if (siteProc == null) return;
            btnSiteStop.Enabled = false;
            statusLabel.Text = "正在停止…";
            Log("[停止] 正在终止…");
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + siteProc.Id + " /T /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process.Start(psi);
            }
            catch { try { siteProc.Kill(); } catch { } }
        }

        void PostSite(string line)
        {
            try { BeginInvoke((MethodInvoker)delegate { HandleSiteLine(line); }); } catch { }
        }

        void HandleSiteLine(string raw)
        {
            string line = raw.TrimEnd();
            if (line.Length == 0) return;
            if (line.Contains("\r")) line = line.Substring(line.LastIndexOf('\r') + 1).Trim();
            if (line.Length == 0) return;

            // 下载进度形如 "    视频(无音轨) 45%  20.1 MB/44.3 MB"
            if (line.Contains("%"))
            {
                int pct = ExtractPercent(line);
                if (pct >= 0)
                {
                    try
                    {
                        int mapped = 10 + (int)(pct * 0.8);
                        if (mapped > progress.Value) progress.Value = Math.Min(90, mapped);
                    }
                    catch { }
                }
                if (siteJobs.Count > 0)
                {
                    var cur0 = siteJobs[siteJobs.Count - 1];
                    if (!cur0.Failed) SetSiteCell(cur0, 0, "下载中 " + pct + "%");
                }
                return;
            }

            Log(line);

            if (line.Contains("━━━ 处理:"))
            {
                string url = After(line, "处理:").Trim();
                var j = new SiteJob();
                j.Url = url;
                var it = new ListViewItem(new string[] { "解析中…", "", "", "", "" });
                j.Row = it;
                listSites.Items.Add(it);
                it.EnsureVisible();
                siteJobs.Add(j);
                return;
            }

            var cur = siteJobs.Count > 0 ? siteJobs[siteJobs.Count - 1] : null;
            if (cur == null) return;

            if (line.Contains("标题:")) { cur.Title = After(line, "标题:"); SetSiteCell(cur, 1, cur.Title); }
            else if (line.Contains("选定:"))
            {
                cur.Quality = After(line, "选定:");
                SetSiteCell(cur, 2, cur.Quality);
            }
            else if (line.TrimStart().StartsWith("✓"))
            {
                long b = ExtractSize(line);
                if (b > 0)
                {
                    cur.Bytes += b;
                    SetSiteCell(cur, 4, FmtSize(cur.Bytes));
                }
            }
            else if (line.Contains("  →  "))
            {
                // 汇总行 "• 标题  →  1 个文件"
                SetSiteCell(cur, 3, "已完成");
                SetSiteCell(cur, 0, "完成");
                cur.Finished = true;
            }
            else if (line.TrimStart().StartsWith("✗") || line.Contains("[致命]") || line.Contains("[warn]"))
            {
                cur.Failed = true;
                SetSiteCell(cur, 0, "失败");
            }
        }

        void SetSiteCell(SiteJob j, int col, string text)
        {
            if (j == null || j.Row == null) return;
            if (col < j.Row.SubItems.Count) j.Row.SubItems[col].Text = text;
        }

        // ═══════════════════════════ 知乎流程 ═══════════════════════════
        // ═══════════════ v1.1.0 三个新页的启动器 ═══════════════
        //
        // 为什么写一个通用的 RunEngineTask 而不是每页复制一套：
        //   抖音/站点/知乎每页都有一套 Start+Stop+ReadLoop+HandleLine+计时器，
        //   加起来 600 多行。再复制三套会让这个文件更难维护，
        //   而且新页都是「一条命令跑完就结束」，不需要逐条解析进度。
        //
        //   所以：一个执行器 + 三个薄薄的参数组装方法。
        //   代价是没有细粒度进度条（只走"启动→运行中→完成"三段），
        //   对这三个功能足够 —— 它们都是"粘链接、等结果"。
        //
        // 复用现有的 engine/jobs/progress/Log/stopping 这套设施，
        // 所以「停止」按钮、日志、状态栏都能直接用。

        /// <summary>通用引擎执行器：起进程、把输出打到日志、结束恢复按钮。</summary>
        void RunEngineTask(string eng, bool unified, string subcmd, string args,
                           string title, string outDir, Button startBtn, Button stopBtn)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = eng;
            psi.Arguments = unified ? (subcmd + " " + args) : args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;

            try
            {
                engine = new Process();
                engine.StartInfo = psi;
                engine.Start();
                stopping = false;
                if (startBtn != null) startBtn.Enabled = false;
                if (stopBtn != null) stopBtn.Enabled = true;
                progress.Style = ProgressBarStyle.Marquee;   // 不知道总量，用跑马灯
                progress.MarqueeAnimationSpeed = 30;
                statusLabel.Text = title + " 进行中…";
                Log("");
                Log("━━━ " + title + " ━━━");
                Log("引擎: " + eng);

                reader = new Thread(delegate()
                {
                    try
                    {
                        string line;
                        while ((line = engine.StandardOutput.ReadLine()) != null)
                        {
                            if (stopping) break;
                            PostLog(line);
                        }
                    }
                    catch { }
                    try
                    {
                        string err;
                        while ((err = engine.StandardError.ReadLine()) != null)
                        {
                            if (stopping) break;
                            // 进度行带 \r，这里只留非空内容
                            string t = err.Trim();
                            if (t.Length > 0) PostLog(t);
                        }
                    }
                    catch { }
                    try { engine.WaitForExit(); } catch { }

                    PostLog("");
                    int code = 0;
                    try { code = engine.ExitCode; } catch { }
                    if (stopping)
                    {
                        PostLog("[已停止]");
                        PostDone(title + " 已停止", outDir, startBtn, stopBtn, 0);
                    }
                    else if (code == 0)
                    {
                        PostLog("[完成] 全部成功");
                        PostDone(title + " 完成", outDir, startBtn, stopBtn, 100);
                    }
                    else
                    {
                        PostLog("[结束] 有失败项，退出码 " + code + "（看上面的 ✗ 行）");
                        PostDone(title + " 部分失败", outDir, startBtn, stopBtn, 100);
                    }
                });
                reader.IsBackground = true;
                reader.Start();
            }
            catch (Exception ex)
            {
                progress.Style = ProgressBarStyle.Blocks;
                Log("[错误] 启动失败: " + ex.Message);
                if (startBtn != null) startBtn.Enabled = true;
                if (stopBtn != null) stopBtn.Enabled = false;
                MsgBox(this, "启动引擎失败:\n" + ex.Message, "错误");
            }
        }

        /// <summary>跨线程写日志（RunEngineTask 的读线程用它，不能直接碰控件）。</summary>
        void PostLog(string line)
        {
            try { BeginInvoke((MethodInvoker)delegate { Log(line); }); } catch { }
        }

        /// <summary>跨线程收尾：恢复按钮、复位进度条。</summary>
        void PostDone(string status, string outDir, Button startBtn, Button stopBtn, int pct)
        {
            try
            {
                BeginInvoke((Action)delegate
                {
                    progress.Style = ProgressBarStyle.Blocks;
                    progress.Value = pct;
                    statusLabel.Text = status;
                    if (startBtn != null) startBtn.Enabled = true;
                    if (stopBtn != null) stopBtn.Enabled = false;
                    engine = null;
                });
            }
            catch { }
        }

        // ─────────── 公众号 ───────────
        void StartWechat()
        {
            SelfLog("[wx] 进入 StartWechat");
            if (!RequireLicense("公众号")) { SelfLog("[wx] 授权未通过"); return; }
            if (engine != null) { SelfLog("[wx] 已有任务在跑"); return; }

            string raw = txtWxUrl.Text.Trim();
            if (raw.Length == 0 || raw == "https://mp.weixin.qq.com/s/")
            {
                MsgOrLog("请先粘贴公众号文章链接", "提示");
                txtWxUrl.Focus();
                return;
            }

            bool uni;
            string eng = FindEngine("公众号下载器.exe", out uni);
            if (eng == null) { SelfLog("[engine] 找不到引擎"); MsgOrLog("找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。", "缺少引擎"); return; }

            string outDir = txtWxOut.Text.Trim();
            if (outDir.Length == 0)
            {
                outDir = Path.Combine(Application.StartupPath, "downloads", "公众号");
                txtWxOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgOrLog("无法创建目录:\n" + ex.Message, "错误"); return; }

            var fmts = new System.Collections.Generic.List<string>();
            fmts.Add("md");
            if (chkWxDocx.Checked) fmts.Add("docx");

            string args = Quote(raw) + " -o " + Quote(outDir)
                + " -f " + string.Join(",", fmts.ToArray())
                + (chkWxNoImages.Checked ? " --no-images" : "");

            RunEngineTask(eng, uni, "wechat", args, "公众号下载", outDir, btnWxStart, null);
        }

        // ─────────── 歌单 ───────────
        void StartPlaylist()
        {
            SelfLog("[pl] 进入 StartPlaylist");
            if (!RequireLicense("歌单")) { SelfLog("[pl] 授权未通过"); return; }
            if (engine != null) { SelfLog("[pl] 已有任务在跑"); return; }

            string raw = txtPlUrl.Text.Trim();
            if (raw.Length == 0)
            {
                MsgOrLog("请先填歌单链接或数字 ID", "提示");
                txtPlUrl.Focus();
                return;
            }

            bool uni;
            string eng = FindEngine("歌单下载器.exe", out uni);
            if (eng == null) { SelfLog("[engine] 找不到引擎"); MsgOrLog("找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。", "缺少引擎"); return; }

            string outDir = txtPlOut.Text.Trim();
            if (outDir.Length == 0)
            {
                outDir = Path.Combine(Application.StartupPath, "downloads", "歌单");
                txtPlOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgOrLog("无法创建目录:\n" + ex.Message, "错误"); return; }

            int lim = (int)numPlLimit.Value;
            string args = Quote(raw) + " -o " + Quote(outDir)
                + (lim > 0 ? " -n " + lim.ToString() : "")
                + (chkPlMeta.Checked ? " --meta" : "");

            Log("");
            Log("提示：已下好的歌会自动跳过，中断后重跑不会重复下载。");
            RunEngineTask(eng, uni, "playlist", args, "歌单下载", outDir, btnPlStart, null);
        }

        // ─────────── 素材 ───────────
        void StartStock()
        {
            SelfLog("[st] 进入 StartStock");
            if (!RequireLicense("免版权素材")) { SelfLog("[st] 授权未通过"); return; }
            if (engine != null) { SelfLog("[st] 已有任务在跑"); return; }

            // 场景选了具体项就用 --scene；选「自定义关键词」才用文本框
            string scene = cmbStScene.SelectedIndex > 0 ? cmbStScene.SelectedItem.ToString() : null;
            string kw = txtStKeyword.Text.Trim();
            if (scene == null && kw.Length == 0)
            {
                MsgOrLog("请选一个场景，或填关键词（英文效果更好）", "提示");
                txtStKeyword.Focus();
                return;
            }

            bool uni;
            string eng = FindEngine("素材下载器.exe", out uni);
            if (eng == null) { SelfLog("[engine] 找不到引擎"); MsgOrLog("找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。", "缺少引擎"); return; }

            string outDir = txtStOut.Text.Trim();
            if (outDir.Length == 0)
            {
                outDir = Path.Combine(Application.StartupPath, "downloads", "素材");
                txtStOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgOrLog("无法创建目录:\n" + ex.Message, "错误"); return; }

            string src = "coverr";
            if (cmbStSource.SelectedIndex == 1) src = "pixabay";
            else if (cmbStSource.SelectedIndex == 2) src = "pexels";

            string args = (scene != null ? "--scene " + Quote(scene) : Quote(kw))
                + " -o " + Quote(outDir)
                + " -n " + ((int)numStLimit.Value).ToString()
                + " --source " + src
                + (chkStLandscape.Checked ? " --landscape" : "");

            // Pixabay/Pexels 没 key 时给一句提示（引擎也会报，但这里更早）
            if (src != "coverr")
            {
                Log("");
                Log("提示：" + src + " 需要 API key。没配过的话先运行：");
                Log("  下载器.exe stock --set-key " + src + " <你的key>");
                Log("（key 免费，存一次长期有效。Coverr 不需要 key。）");
            }

            RunEngineTask(eng, uni, "stock", args, "素材下载", outDir, btnStStart, null);
        }

        void StartZhihu()
        {
            if (!RequireLicense("知乎抓取")) return;
            if (zhihuProc != null) { MsgBox(this, "抓取进行中，请稍等", "提示"); return; }

            string raw = txtZhihuUrl.Text.Trim();
            if (raw.Length == 0)
            {
                MsgBox(this, "请先粘贴知乎链接", "提示");
                txtZhihuUrl.Focus();
                return;
            }

            bool uniZ;
            string engZ = FindEngine("知乎下载器.exe", out uniZ);
            if (engZ == null)
            {
                MsgBox(this,
                    "找不到引擎。\n\n请把「下载器.exe」和本程序放在同一个文件夹。",
                    "缺少引擎", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string outDir = txtZhihuOut.Text.Trim();
            if (outDir.Length == 0)
            {
                // 布局异常或用户清空时兜底，避免 CreateDirectory("") 抛异常
                outDir = Path.Combine(Application.StartupPath, "downloads", "文章");
                txtZhihuOut.Text = outDir;
            }
            try { if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir); }
            catch (Exception ex) { MsgBox(this, "无法创建目录:\n" + ex.Message, "错误"); return; }

            listZhihu.Items.Clear();
            zhihuJobs.Clear();
            zhihuDone = 0;
            zhihuExpect = 0;

            btnZhihuStart.Enabled = false;
            btnZhihuStop.Enabled = true;
            progress.Value = 10;
            statusLabel.Text = "知乎抓取中…";
            Log("");
            Log("━━━ 知乎抓取 ━━━");

            var psi = new ProcessStartInfo();
            psi.FileName = engZ;
            var zf = new System.Collections.Generic.List<string>();
            if (chkFmtMd.Checked) zf.Add("md");
            if (chkFmtTxt.Checked) zf.Add("txt");
            if (chkFmtDocx.Checked) zf.Add("docx");
            if (zf.Count == 0) zf.Add("md");   // 全不勾时退回 md，避免什么都不输出
            string zArgs = Quote(raw) + " -o " + Quote(outDir)
                + " --format " + string.Join(",", zf)
                + (chkZhihuHeadful.Checked ? " --headful" : "")
                // 「顺带下载图片到本地」以前是死复选框：控件建了、坐标排了，
                // 但 StartZhihu 从来没读过它的状态，勾不勾行为完全一样。
                // 引擎侧默认开着图片本地化，所以不勾时必须显式传 --no-images。
                + (chkZhihuClip.Checked ? "" : " --no-images");
            psi.Arguments = uniZ ? "zhihu " + zArgs : zArgs;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Application.StartupPath;
            // 自检模式下告诉引擎跳过激活闸门（否则回归测试全被拦）
            // 自检旁路已通过进程级环境变量设置（见 BeginSelfTest），子进程自动继承

            try
            {
                var p = new Process();
                p.StartInfo = psi;
                zhihuProc = p;
                p.Start();

                // ── 抓取全程的计时/看门狗 ──
                // 旧版进度条只会 10 → 100/0 两跳，中间完全不动。引擎若因任何原因
                // 迟迟不退出（历史上是 CDP 的 60 秒定时器），界面看起来就是死了。
                // 这里让进度条随输出推进，并在静默时把状态改成"仍在运行 + 已等待N秒"。
                zhihuStartAt = DateTime.Now;
                zhihuLastOutput = DateTime.Now;
                zhihuStage = 10;
                if (zhihuWatch != null) { zhihuWatch.Stop(); zhihuWatch.Dispose(); }
                zhihuWatch = new System.Windows.Forms.Timer();
                zhihuWatch.Interval = 1000;
                zhihuWatch.Tick += delegate { ZhihuWatchTick(); };
                zhihuWatch.Start();

                Thread t = new Thread(delegate ()
                {
                    try
                    {
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null) PostZhihu(line);
                    }
                    catch { }
                    try
                    {
                        string eline;
                        while ((eline = p.StandardError.ReadLine()) != null) PostZhihu(eline);
                    }
                    catch { }
                    try { p.WaitForExit(); } catch { }

                    BeginInvoke((MethodInvoker)delegate
                    {
                        int code = -1;
                        try { code = p.ExitCode; } catch { }
                        if (zhihuWatch != null) { zhihuWatch.Stop(); zhihuWatch.Dispose(); zhihuWatch = null; }
                        zhihuProc = null;
                        btnZhihuStart.Enabled = true;
                        btnZhihuStop.Enabled = false;
                        statusLabel.Text = code == 0 ? "抓取完成" : "抓取结束（有失败）";
                        if (code != 0) AutoReport("zhihu-fail", "知乎抓取退出码 " + code, "");
                        progress.Value = code == 0 ? 100 : 0;
                        Log("");
                        Log(code == 0 ? "━━━ 全部完成 ━━━" : "━━━ 结束（退出码 " + code + "）━━━");
                        Log("耗时 " + ElapsedText() + "");
                        int ok = 0, bad = 0;
                        foreach (var j in zhihuJobs) { if (j.Failed) bad++; else { j.Finished = true; SetZCell(j, 0, "完成"); ok++; } }
                        if (zhihuJobs.Count > 0) Log("成功 " + ok + " 篇，失败 " + bad + " 篇");
                        try { p.Dispose(); } catch { }
                    });
                });
                t.IsBackground = true;
                t.Start();
            }
            catch (Exception ex)
            {
                zhihuProc = null;
                btnZhihuStart.Enabled = true;
                btnZhihuStop.Enabled = false;
                Log("[错误] 启动失败: " + ex.Message);
                MsgBox(this, "启动引擎失败:\n" + ex.Message, "错误");
            }
        }

        void StopZhihu()
        {
            if (zhihuProc == null) return;
            btnZhihuStop.Enabled = false;
            statusLabel.Text = "正在停止…";
            Log("[停止] 正在终止…");
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + zhihuProc.Id + " /T /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process.Start(psi);
            }
            catch { try { zhihuProc.Kill(); } catch { } }
        }

        void PostZhihu(string line)
        {
            try { BeginInvoke((MethodInvoker)delegate { HandleZhihuLine(line); }); } catch { }
        }

        void HandleZhihuLine(string raw)
        {
            string line = raw.TrimEnd();
            if (line.Length == 0) return;
            BumpZhihuProgress(line);
            Log(line);

            // 新任务：形如 "━━━ https://zhuanlan.zhihu.com/p/xxx"
            if (line.StartsWith("━━━ http"))
            {
                var job = new ZhihuJob();
                job.Url = line.Substring(4).Trim();
                var it = new ListViewItem(new string[] { "抓取中…", "", "", "", "" });
                job.Row = it;
                listZhihu.Items.Add(it);
                it.EnsureVisible();
                zhihuJobs.Add(job);
                zhihuExpect++;
                return;
            }

            var cur = zhihuJobs.Count > 0 ? zhihuJobs[zhihuJobs.Count - 1] : null;
            if (cur == null) return;

            // "  ✓ 标题_xxxx.md"
            if (line.TrimStart().StartsWith("✓"))
            {
                string name = line.TrimStart().Substring(1).Trim();
                cur.Title = name;
                SetZCell(cur, 1, name);
                SetZCell(cur, 4, name);
                SetZCell(cur, 0, "已保存");
                return;
            }

            // "    12.3 KB  字数 7793  图片 8"
            if (line.Contains("字数"))
            {
                int ci = line.IndexOf("字数");
                int ii = line.IndexOf("图片");
                int chars = 0, imgs = 0;
                if (ci >= 0)
                {
                    string sub = line.Substring(ci + 2).Trim();
                    int sp = sub.IndexOf(' ');
                    if (sp < 0) sp = sub.Length;
                    int.TryParse(sub.Substring(0, sp).Trim(), out chars);
                }
                if (ii >= 0)
                {
                    string sub = line.Substring(ii + 2).Trim();
                    int sp = sub.IndexOf(' ');
                    if (sp < 0) sp = sub.Length;
                    int.TryParse(sub.Substring(0, sp).Trim(), out imgs);
                }
                cur.Chars = chars;
                cur.Images = imgs;
                SetZCell(cur, 2, chars.ToString());
                SetZCell(cur, 3, imgs.ToString());
                return;
            }

            // "    C:\path\xxx.md"
            if (line.TrimStart().StartsWith("C:\\") || line.TrimStart().StartsWith("E:\\") || line.TrimStart().StartsWith("D:\\"))
            {
                cur.Dest = line.Trim();
                return;
            }

            if (line.TrimStart().StartsWith("✗") || line.Contains("抓取失败") || line.Contains("[致命]"))
            {
                cur.Failed = true;
                SetZCell(cur, 0, "失败");
            }
        }

        void SetZCell(ZhihuJob j, int col, string text)
        {
            if (j == null || j.Row == null) return;
            if (col < j.Row.SubItems.Count) j.Row.SubItems[col].Text = text;
        }

        // ═══════════════════════════ 知乎进度 ═══════════════════════════
        // 设计目标：进度条任何时候都在动，静默超过阈值就把状态说清楚，
        // 绝不再出现"界面看着像死了、其实后台已经跑完"的情况。
        string ElapsedText()
        {
            if (zhihuStartAt == DateTime.MinValue) return "-";
            TimeSpan ts = DateTime.Now - zhihuStartAt;
            if (ts.TotalMinutes >= 1)
                return ((int)ts.TotalMinutes) + " 分 " + ts.Seconds + " 秒";
            return ts.Seconds + " 秒";
        }

        void ZhihuWatchTick()
        {
            if (zhihuProc == null) return;

            TimeSpan idle = DateTime.Now - zhihuLastOutput;
            int cap = 92;

            // 有输出 → 按阶段推进；没输出 → 缓慢爬升，但不到顶
            int pct;
            if (zhihuExpect > 0)
                pct = zhihuStage + (int)((cap - zhihuStage) * Math.Min(1.0, (double)zhihuDone / zhihuExpect));
            else
                pct = zhihuStage;

            // 静默时每秒给 1%，最多爬到 cap，让用户看到"还在跑"
            if (idle.TotalSeconds > 3)
                pct = Math.Min(cap, Math.Max(pct, zhihuStage + (int)(idle.TotalSeconds - 3)));

            try { if (pct > progress.Value && pct <= 100) progress.Value = pct; } catch { }

            string stageName =
                zhihuStage >= 90 ? "收尾中…" :
                zhihuStage >= 50 ? "抓取正文…" :
                zhihuStage >= 30 ? "浏览器就绪，等待页面…" :
                zhihuStage >= 20 ? "启动浏览器…" : "启动引擎…";

            if (idle.TotalSeconds >= 20)
                statusLabel.Text = stageName + "  已等待 " + ElapsedText() + "（后台仍在运行）";
            else
                statusLabel.Text = stageName + "  " + ElapsedText();
        }

        /// <summary>引擎每吐一行就更新阶段与活动时间</summary>
        void BumpZhihuProgress(string line)
        {
            zhihuLastOutput = DateTime.Now;

            if (line.StartsWith("输出目录:")) { zhihuStage = Math.Max(zhihuStage, 20); return; }
            if (line.Contains("启动浏览器")) { zhihuStage = Math.Max(zhihuStage, 20); return; }
            if (line.Contains("浏览器就绪")) { zhihuStage = Math.Max(zhihuStage, 30); return; }
            if (line.Contains("━━━ 汇总")) { zhihuStage = Math.Max(zhihuStage, 90); return; }
            if (line.TrimStart().StartsWith("✓")) { zhihuDone++; zhihuStage = Math.Max(zhihuStage, 50); return; }
            if (line.Contains("字数")) { zhihuStage = Math.Max(zhihuStage, 70); return; }
        }

        // ═══════════════════════════ 关闭 ═══════════════════════════
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (engine != null || musicProc != null || zhihuProc != null)
            {
                var r = MsgBox(this, "任务还在进行，确定退出？", "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes) { e.Cancel = true; return; }
                try
                {
                    int pid = engine != null ? engine.Id
                        : (musicProc != null ? musicProc.Id : zhihuProc.Id);
                    var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                }
                catch { }
            }
            base.OnFormClosing(e);
        }
    }
}
