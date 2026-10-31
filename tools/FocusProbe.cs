using System;using System.Diagnostics;using System.Runtime.InteropServices;using System.Text;using System.Threading;
static class F{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct SI{public int cb;public string r,d,t;public int a,b,c,e,f,g,h;public int flags;public short show;public short r2;public IntPtr p2,i,o,er;}
 [StructLayout(LayoutKind.Sequential)]struct PI{public IntPtr hp,ht;public int pid,tid;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool CreateProcess(string a,string c,IntPtr pa,IntPtr ta,bool inh,uint fl,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 static string T(IntPtr h){var s=new StringBuilder(256);GetWindowText(h,s,256);return s.ToString();}
 static void Main(string[] a){
  Console.OutputEncoding=Encoding.UTF8;
  IntPtr fg0=GetForegroundWindow();
  Console.WriteLine("fg_before=["+T(fg0)+"]");
  var si=new SI();si.cb=Marshal.SizeOf(si);
  if(a.Length>1 && a[1]=="noact"){si.flags=1;si.show=4;}   // STARTF_USESHOWWINDOW + SW_SHOWNOACTIVATE
  PI pi;
  string cmd=null;
  bool ok=CreateProcess(a[0],cmd,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,System.IO.Path.GetDirectoryName(a[0]),ref si,out pi);
  if(!ok){Console.WriteLine("CreateProcess failed "+Marshal.GetLastWin32Error());return;}
  CloseHandle(pi.ht);
  int stolen=0;string first=null;var sw=Stopwatch.StartNew();
  while(sw.Elapsed.TotalSeconds<12){
   Thread.Sleep(300);
   IntPtr n=GetForegroundWindow();
   if(n!=fg0){stolen++;if(first==null)first=(int)sw.Elapsed.TotalSeconds+"s ["+T(n)+"]";}
  }
  Console.WriteLine("stolen_samples="+stolen+" first="+(first??"none"));
  Console.WriteLine("RESULT="+(stolen==0?"NO_FOCUS_STOLEN":"FOCUS_STOLEN"));
  try{var p=Process.GetProcessById(pi.pid);p.Kill();}catch{}
 }
}
