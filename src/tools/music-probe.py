import json, urllib.parse, urllib.request, re, sys

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
KEY = "雨爱"

def get(url, referer, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": referer,
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def head(url, referer, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": referer,
    }, method="GET")
    opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, r.geturl(), r.headers.get("Content-Type"), r.headers.get("Content-Length")
    except Exception as e:
        return "ERR", str(e)[:120], "", ""

# ---------- QQ 音乐 ----------
print("=" * 60)
print("[QQ音乐]")
qq_songs = []
try:
    q = urllib.parse.quote(KEY)
    raw = get(f"https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w={q}&format=json", "https://y.qq.com/")
    d = json.loads(raw)
    for s in d["data"]["song"]["list"][:5]:
        singer = "/".join(x["name"] for x in s.get("singer", []))
        qq_songs.append({"mid": s["songmid"], "name": s["songname"], "singer": singer,
                         "album": s.get("albumname", "")})
        print(f"  {s['songname']} - {singer}  mid={s['songmid']}")
except Exception as e:
    print("  搜索失败:", e)

# 测试 vkey 直取
if qq_songs:
    mid = qq_songs[0]["mid"]
    body = {
        "req_0": {"module": "vkey.GetVkeyServer", "method": "CgiGetVkey",
                  "param": {"guid": "7332953976", "songmid": [mid], "songtype": [0],
                            "uin": "0", "loginflag": 1, "platform": "20"}},
        "comm": {"uin": "0", "format": "json", "ct": 24, "cv": 0, "platform": "20"},
    }
    u = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" + urllib.parse.quote(json.dumps(body))
    try:
        raw = get(u, "https://y.qq.com/")
        j = json.loads(raw)
        mi = j["req_0"]["data"]["midurlinfo"][0]
        sip = j["req_0"]["data"]["sip"][0]
        purl = mi.get("purl", "")
        print(f"  vkey result={mi.get('result')} purl={'有' if purl else '空'}")
        if purl:
            full = sip.replace("http://", "https://") + purl
            st, url, ctype, clen = head(full, "https://y.qq.com/")
            print(f"  直链测试: {st} {ctype} {clen} bytes")
    except Exception as e:
        print("  vkey 失败:", e)

# ---------- 网易云 ----------
print("=" * 60)
print("[网易云]")
ne_songs = []
try:
    q = urllib.parse.quote(KEY)
    raw = get(f"https://music.163.com/api/search/get/web?s={q}&type=1&limit=5", "https://music.163.com/")
    d = json.loads(raw)
    for s in d["result"]["songs"][:5]:
        singer = "/".join(a["name"] for a in s.get("artists", []))
        ne_songs.append({"id": s["id"], "name": s["name"], "singer": singer,
                         "album": s.get("album", {}).get("name", "")})
        print(f"  {s['name']} - {singer}  id={s['id']}")
except Exception as e:
    print("  搜索失败:", e)

if ne_songs:
    sid = ne_songs[0]["id"]
    st, url, ctype, clen = head(f"https://music.163.com/song/media/outer/url?id={sid}.mp3", "https://music.163.com/")
    print(f"  outer 直链: {st}  {ctype}  {clen}")
    print(f"  落地: {url[:110]}")

# ---------- 酷我 ----------
print("=" * 60)
print("[酷我]")
kw_songs = []
try:
    q = urllib.parse.quote(KEY)
    raw = get(f"http://search.kuwo.cn/r.s?all={q}&ft=music&itemset=web_2013&client=kt&pn=0&rn=5&rformat=json&encoding=utf8",
              "http://www.kuwo.cn/")
    txt = raw.decode("utf-8", "ignore").replace("'", '"')
    d = json.loads(txt)
    for s in d.get("abslist", [])[:5]:
        rid = s.get("MUSICRID", "")
        name = s.get("SONGNAME", "")
        artist = s.get("ARTIST", "")
        kw_songs.append({"rid": rid, "name": name, "singer": artist, "album": s.get("ALBUM", "")})
        print(f"  {name} - {artist}  {rid}")
except Exception as e:
    print("  搜索失败:", str(e)[:150])

if kw_songs:
    rid = kw_songs[0]["rid"]
    st, url, ctype, clen = head(
        f"http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid={rid}",
        "http://www.kuwo.cn/")
    print(f"  anti.s: {st}  {ctype}  {clen}")
    print(f"  落地: {url[:110]}")
