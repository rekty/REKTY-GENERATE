"""
scripts/backup.py — Backup otomatis REKTY GENERATOR.

Jalankan SETIAP kali selesai perubahan besar:
    python scripts/backup.py

Yang dilakukan:
1. Git tag baru   backup-<YYYY-MM-DD-HHMM>   -> HEAD (commit terakhir)
2. Zip lengkap proyek (tanpa .git, node_modules, .wrangler, .freebuff,
   file *.tmp, __pycache__) disimpan di folder induk:
       "REKTY GENERATOR BACKUP <tanggal>.zip"

Opsional:
    python scripts/backup.py "pesan backup"      # pesan tag khusus
    python scripts/backup.py --out C:\\backup     # folder zip lain
"""
import datetime
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', '.freebuff', 'node_modules', '.wrangler', '__pycache__'}
SKIP_SUFFIXES = ('.tmp',)


def main():
    # --- parse argumen ---
    out_dir = None
    args = []
    i = 0
    while i < len(sys.argv[1:]):
        a = sys.argv[1 + i]
        if a == '--out' and i + 1 < len(sys.argv[1:]):
            out_dir = sys.argv[2 + i]
            i += 2
            continue
        args.append(a)
        i += 1
    msg = ' '.join(args).strip() or 'Backup otomatis'

    ts = datetime.datetime.now()

    # --- 1. git tag ---
    tag = 'backup-' + ts.strftime('%Y-%m-%d-%H%M')
    r = subprocess.run(['git', 'tag', '-a', tag, '-m', msg], cwd=ROOT,
                       capture_output=True, text=True)
    if r.returncode != 0:
        # nama bentrok (2x dalam menit yang sama) -> tambah detik
        tag = 'backup-' + ts.strftime('%Y-%m-%d-%H%M%S')
        r = subprocess.run(['git', 'tag', '-a', tag, '-m', msg], cwd=ROOT,
                           capture_output=True, text=True)
    if r.returncode != 0:
        print('! Gagal membuat tag:', r.stderr.strip())
        tag = None
    else:
        print('Tag dibuat:', tag)

    # --- peringatan kalau ada perubahan belum di-commit ---
    st = subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT,
                        capture_output=True, text=True)
    dirty = [ln for ln in st.stdout.splitlines() if ln.strip()]
    if dirty:
        print('! Working tree ada %d perubahan belum di-commit — tag menunjuk '
              'ke commit terakhir (zip tetap memuat file terbaru).' % len(dirty))

    # --- 2. zip proyek ---
    out_dir = out_dir or os.path.dirname(ROOT)
    out = os.path.join(out_dir, 'REKTY GENERATOR BACKUP %s.zip'
                       % ts.strftime('%Y-%m-%d %H%M'))
    files = []
    for root, dirs, fnames in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in fnames:
            if f.endswith(SKIP_SUFFIXES):
                continue
            p = os.path.join(root, f)
            files.append((p, os.path.relpath(p, ROOT)))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for p, rel in files:
            z.write(p, rel)
    print('Zip dibuat:', out)
    print('  file: %d | ukuran: %.1f KB' % (len(files), os.path.getsize(out) / 1024))

    # --- selesai ---
    print()
    print('Selesai. Untuk menyimpan backup tag ke GitHub:')
    print('  git push origin %s' % (tag or '<tag>'))


if __name__ == '__main__':
    main()
