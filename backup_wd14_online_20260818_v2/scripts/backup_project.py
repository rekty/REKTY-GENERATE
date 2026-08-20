"""Backup project REKTY GENERATOR ke zip dengan nama berisi tanggal & jam.

Contoh: D:\\REKTY GENERATOR 18 08 26 01 52.zip
Kecuali folder besar/tidak perlu: .git, .freebuff, node_modules, .wrangler, __pycache__.
"""
import os
import sys
import time
import zipfile

SRC = r"D:\REKTY GENERATOR"
OUT_DIR = "D:/"
EXCL_DIRS = {".git", ".freebuff", "node_modules", "__pycache__", ".agents", ".wrangler"}
EXCL_EXT = {".zip"}
EXCL_FILES = {"firebase-debug.log"}


def main():
    stamp = time.strftime("%d %m %y %H %M")
    out = os.path.join(OUT_DIR, "REKTY GENERATOR %s.zip" % stamp)
    if os.path.exists(out):
        os.remove(out)
    count = total = 0
    t0 = time.time()
    base = os.path.dirname(SRC)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in dirs if d not in EXCL_DIRS]
            for f in sorted(files):
                if os.path.splitext(f)[1].lower() in EXCL_EXT or f in EXCL_FILES:
                    continue
                fp = os.path.join(root, f)
                # rel sudah berisi nama folder SRC (mis. "REKTY GENERATOR/index.html") karena
                # base = dirname(SRC) = D:/ — jangan tambahkan prefix lagi.
                rel = os.path.relpath(fp, base).replace(os.sep, "/")
                try:
                    z.write(fp, rel)
                    count += 1
                    total += os.path.getsize(fp)
                except Exception as e:
                    print("skip", rel, e)
    mb = 1024 * 1024
    print("OK: %d file, %.1f MB -> zip %.1f MB (%s), %.1fs" % (
        count, total / mb, os.path.getsize(out) / mb, os.path.basename(out), time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
