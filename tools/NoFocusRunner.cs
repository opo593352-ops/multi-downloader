using System;using System.Collections.Generic;using System.Diagnostics;using System.Runtime.InteropServices;using System.Text;using System.Threading;
static class R{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct SI{public int cb;public string r,d,t;public int a,b,c,e,f,g,h;public int flags;public short show;public short r2;public IntPtr p2,i,o,er;}
 [StructLayout(LayoutKind.Sequential)]struct PI{public IntPtr hp,ht;public int pid,tid;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool CreateProcess(string a,string c,IntPtr pa,IntPtr ta,bool inh,uint fl,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 static string T(IntPtr h){var s=new StringBuilder(256);GetWindowText(h,s,256);return s.ToString();}
 static bool Run(string exe,string[] args,int timeoutSec,out int stolen,out string result){
  stolen=0;result=null;
  IntPtr fg0=GetForegroundWindow();
  var si=new SI();si.cb=Marshal.SizeOf(si);si.flags=1;si.show=4;
  var sb=new StringBuilder();
  foreach(var a in args){if(sb.Length>0)sb.Append(' ');sb.Append('"').Append(a).Append('"');}
  string cmdLine="\""+exe+"\" "+sb;
  PI pi;
  if(!CreateProcess(exe,cmdLine,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,System.IO.Path.GetDirectoryName(exe),ref si,out pi)){
   Console.WriteLine("CreateProcess failed "+Marshal.GetLastWin32Error());return false;}
  CloseHandle(pi.ht);
  var sw=Stopwatch.StartNew();
  while(sw.Elapsed.TotalSeconds<timeoutSec){
   Thread.Sleep(250);
   if(GetForegroundWindow()!=fg0)stolen++;
   bool alive=true;
   try{var p=Process.GetProcessById(pi.pid);alive=!p.HasExited;}catch{alive=false;}
   if(!alive)break;
  }
  bool exited=true;
  try{var p=Process.GetProcessById(pi.pid);exited=p.HasExited; if(!exited)p.Kill();}catch{}
  return exited;
 }
 static void Main(string[] a){
  Console.OutputEncoding=Encoding.UTF8;
  string exe=a[0];
  string resDir=@"C:\temp\stres";
  System.IO.Directory.CreateDirectory(resDir);
  var cases=new List<string[]>{
   new[]{"zhihu","https://zhuanlan.zhihu.com/p/25772027","zhihu"},
   new[]{"music","雨爱","music"},
  };
  Console.WriteLine("fg_at_start=["+T(GetForegroundWindow())+"]");
  int totalStolen=0;
  foreach(var c in cases){
   string rf=System.IO.Path.Combine(resDir,c[2]+".txt");
   if(System.IO.File.Exists(rf))System.IO.File.Delete(rf);
   var args=new List<string>{"--selftest",c[0],c[1],rf,"--quiet"};
   int st;string r;
   var sw=Stopwatch.StartNew();
   bool exited=Run(exe,args.ToArray(),180,out st,out r);
   totalStolen+=st;
   Console.WriteLine("--- case="+c[0]+" exited="+exited+" elapsed="+(int)sw.Elapsed.TotalSeconds+"s focusStolenSamples="+st);
   if(System.IO.File.Exists(rf)){
    foreach(var line in System.IO.File.ReadAllLines(rf)) if(line.StartsWith("RESULT=")||line.StartsWith("SEQUENCE=")||line.StartsWith("ELAPSED_MS="))Console.WriteLine("    "+line);
   } else Console.WriteLine("    NO RESULT FILE");
  }
  Console.WriteLine("TOTAL_FOCUS_STOLEN_SAMPLES="+totalStolen);
  Console.WriteLine(totalStolen==0?"FOCUS_TEST=PASS":"FOCUS_TEST=FAIL");
 }
}
