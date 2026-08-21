import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('index.html', 'utf8');

// Step 1: Add data-t attributes to HTML elements
const htmlReplacements = [
  ['<label class="text-[11px] text-neutral-500">Provider</label>', '<label class="text-[11px] text-neutral-500" data-t="provider">Provider</label>'],
  ['<label class="text-[11px] text-neutral-500">Login Pollinations</label>', '<label class="text-[11px] text-neutral-500" data-t="loginPollinations">Login Pollinations</label>'],
  ['Login dengan Pollinations (BYOP)</button>', '<span data-t="loginByop">Login dengan Pollinations (BYOP)</span></button>'],
  ['<label class="text-[11px] text-neutral-500">Mode</label>', '<label class="text-[11px] text-neutral-500" data-t="modeLabel">Mode</label>'],
  ['<option value="demo">Demo (simulasi saja)</option>', '<option value="demo" data-t="demoMode">Demo (simulasi saja)</option>'],
  ['<button id="api-save" class="btn btn-ghost flex-1 h-8 border bd text-xs">Simpan</button>', '<button id="api-save" class="btn btn-ghost flex-1 h-8 border bd text-xs" data-t="save">Simpan</button>'],
  ['<button id="api-test" class="btn btn-ghost flex-1 h-8 border bd text-xs">Tes</button>', '<button id="api-test" class="btn btn-ghost flex-1 h-8 border bd text-xs" data-t="test">Tes</button>'],
  ['<span>Durasi Animasi</span>', '<span data-t="durasi">Durasi Animasi</span>'],
  ['<button class="rtab" data-p="history">Riwayat</button>', '<button class="rtab" data-p="history" data-t="history">Riwayat</button>'],
  ['title="Riwayat percakapan"', 'data-t-title="history" title="Riwayat percakapan"'],
  ['title="Kembali ke atas"', 'data-t-title="scrollTop" title="Kembali ke atas"'],
  ['title="Acak seed"', 'data-t-title="random" title="Acak seed"'],
];

for (const [old, rep] of htmlReplacements) {
  if (c.includes(old)) {
    c = c.replace(old, rep);
  }
}

// Step 2: Add new keys to each language block
// Strategy: Find each language block by '  xx:{' and add keys before its closing '},'
const langs = ['id','en','ja','ko','zh','es','fr','de','pt','ru','ar','hi','th','vi','tr','pl','nl','it'];

const newKeys = {
  id: {loginPollinations:'Login Pollinations',loginByop:'Login dengan Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (wajib backend)',demoMode:'Demo (simulasi saja)',byopDesc:'Model otomatis. Isi key sk_* dari enter.pollinations.ai/keys.',save:'Simpan',test:'Tes',durasi:'Durasi Animasi',history:'Riwayat',scrollTop:'Kembali ke atas',random:'Acak seed'},
  en: {loginPollinations:'Login Pollinations',loginByop:'Login with Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (backend required)',demoMode:'Demo (simulation only)',byopDesc:'Auto model. Enter sk_* key from enter.pollinations.ai/keys.',save:'Save',test:'Test',durasi:'Animation Duration',history:'History',scrollTop:'Back to top',random:'Random seed'},
  ja: {loginPollinations:'Pollinations ログイン',loginByop:'Pollinations でログイン (BYOP)',modeLabel:'モード',realApi:'リアル API (バックエンド必須)',demoMode:'デモ (シミュレーションのみ)',byopDesc:'自動モデル。enter.pollinations.ai/keys から sk_* キーを入力。',save:'保存',test:'テスト',durasi:'アニメーション時間',history:'履歴',scrollTop:'トップに戻る',random:'ランダムシード'},
  ko: {loginPollinations:'Pollinations 로그인',loginByop:'Pollinations으로 로그인 (BYOP)',modeLabel:'모드',realApi:'실제 API (백엔드 필수)',demoMode:'데모 (시뮬레이션만)',byopDesc:'자동 모델. enter.pollinations.ai/keys에서 sk_* 키를 입력.',save:'저장',test:'테스트',durasi:'애니메이션 시간',history:'기록',scrollTop:'맨 위로',random:'랜덤 시드'},
  zh: {loginPollinations:'Pollinations 登录',loginByop:'使用 Pollinations 登录 (BYOP)',modeLabel:'模式',realApi:'真实 API (需要后端)',demoMode:'演示 (仅模拟)',byopDesc:'自动模型。从 enter.pollinations.ai/keys 输入 sk_* 密钥。',save:'保存',test:'测试',durasi:'动画时长',history:'历史',scrollTop:'返回顶部',random:'随机种子'},
  es: {loginPollinations:'Iniciar sesión Pollinations',loginByop:'Iniciar con Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (requiere backend)',demoMode:'Demo (solo simulación)',byopDesc:'Modelo automático. Ingresa clave sk_* de enter.pollinations.ai/keys.',save:'Guardar',test:'Probar',durasi:'Duración',history:'Historial',scrollTop:'Volver arriba',random:'Semilla aleatoria'},
  fr: {loginPollinations:'Connexion Pollinations',loginByop:'Se connecter avec Pollinations (BYOP)',modeLabel:'Mode',realApi:'API Réel (backend requis)',demoMode:'Démo (simulation uniquement)',byopDesc:'Modèle automatique. Entrez la clé sk_* de enter.pollinations.ai/keys.',save:'Enregistrer',test:'Tester',durasi:'Durée',history:'Historique',scrollTop:'Retour en haut',random:'Graine aléatoire'},
  de: {loginPollinations:'Pollinations anmelden',loginByop:'Mit Pollinations anmelden (BYOP)',modeLabel:'Modus',realApi:'Echte API (Backend erforderlich)',demoMode:'Demo (nur Simulation)',byopDesc:'Automatisches Modell. Geben Sie sk_* Schlüssel von enter.pollinations.ai/keys ein.',save:'Speichern',test:'Testen',durasi:'Dauer',history:'Verlauf',scrollTop:'Nach oben',random:'Zufälliger Seed'},
  pt: {loginPollinations:'Login Pollinations',loginByop:'Login com Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (backend necessário)',demoMode:'Demo (apenas simulação)',byopDesc:'Modelo automático. Insira chave sk_* de enter.pollinations.ai/keys.',save:'Salvar',test:'Testar',durasi:'Duração',history:'Histórico',scrollTop:'Voltar ao topo',random:'Semente aleatória'},
  ru: {loginPollinations:'Вход Pollinations',loginByop:'Войти через Pollinations (BYOP)',modeLabel:'Режим',realApi:'Настоящий API (требуется бэкенд)',demoMode:'Демо (только симуляция)',byopDesc:'Автоматическая модель. Введите sk_* ключ с enter.pollinations.ai/keys.',save:'Сохранить',test:'Тест',durasi:'Длительность',history:'История',scrollTop:'Наверх',random:'Случайный种子'},
  ar: {loginPollinations:'تسجيل دخول Pollinations',loginByop:'تسجيل الدخول عبر Pollinations (BYOP)',modeLabel:'الوضع',realApi:'API حقيقي (يتطلب خلفية)',demoMode:'عرض (محاكاة فقط)',byopDesc:'نموذج تلقائي. أدخل مفتاح sk_* من enter.pollinations.ai/keys.',save:'حفظ',test:'اختبار',durasi:'المدة',history:'السجل',scrollTop:'العودة للأعلى',random:'بذرة عشوائية'},
  hi: {loginPollinations:'Pollinations लॉगिन',loginByop:'Pollinations से लॉगिन करें (BYOP)',modeLabel:'मोड',realApi:'असली API (बैकएंड आवश्यक)',demoMode:'डेमो (केवल सिमुलेशन)',byopDesc:'स्वचालित मॉडल। enter.pollinations.ai/keys से sk_* कुंजी दर्ज करें।',save:'सहेजें',test:'परीक्षण',durasi:'अवधि',history:'इतिहास',scrollTop:'ऊपर जाएं',random:'यादृच्छिक बीज'},
  th: {loginPollinations:'เข้าสู่ระบบ Pollinations',loginByop:'เข้าสู่ระบบด้วย Pollinations (BYOP)',modeLabel:'โหมด',realApi:'API จริง (ต้องการ backend)',demoMode:'สาธิต (จำลองเท่านั้น)',byopDesc:'โมเดลอัตโนมัติ ป้อนคีย์ sk_* จาก enter.pollinations.ai/keys',save:'บันทึก',test:'ทดสอบ',durasi:'ระยะเวลา',history:'ประวัติ',scrollTop:'กลับด้านบน',random:'เมล็ดสุ่ม'},
  vi: {loginPollinations:'Đăng nhập Pollinations',loginByop:'Đăng nhập với Pollinations (BYOP)',modeLabel:'Chế độ',realApi:'API Thực (cần backend)',demoMode:'Demo (chỉ mô phỏng)',byopDesc:'Model tự động. Nhập sk_* key từ enter.pollinations.ai/keys.',save:'Lưu',test:'Kiểm tra',durasi:'Thời lượng',history:'Lịch sử',scrollTop:'Lên đầu trang',random:'Hạt giống ngẫu nhiên'},
  tr: {loginPollinations:'Pollinations Girişi',loginByop:'Pollinations ile Giriş (BYOP)',modeLabel:'Mod',realApi:'Gerçek API (backend gerekli)',demoMode:'Demo (yalnızca simülasyon)',byopDesc:'Otomatik model. enter.pollinations.ai/keys adresinden sk_* anahtarını girin.',save:'Kaydet',test:'Test',durasi:'Süre',history:'Geçmiş',scrollTop:'Başa dön',random:'Rastgele tohum'},
  pl: {loginPollinations:'Logowanie Pollinations',loginByop:'Zaloguj się przez Pollinations (BYOP)',modeLabel:'Tryb',realApi:'Prawdziwe API (wymagany backend)',demoMode:'Demo (tylko symulacja)',byopDesc:'Automatyczny model. Wprowadź klucz sk_* z enter.pollinations.ai/keys.',save:'Zapisz',test:'Testuj',durasi:'Czas trwania',history:'Historia',scrollTop:'Powrót na górę',random:'Losowe nasiono'},
  nl: {loginPollinations:'Pollinations Inloggen',loginByop:'Inloggen met Pollinations (BYOP)',modeLabel:'Modus',realApi:'Echte API (backend vereist)',demoMode:'Demo (alleen simulatie)',byopDesc:'Automatisch model. Voer sk_* sleutel in van enter.pollinations.ai/keys.',save:'Opslaan',test:'Testen',durasi:'Duur',history:'Geschiedenis',scrollTop:'Terug naar boven',random:'Willekeurig zaad'},
  it: {loginPollinations:'Accesso Pollinations',loginByop:'Accedi con Pollinations (BYOP)',modeLabel:'Modalità',realApi:'API Reale (backend necessario)',demoMode:'Demo (solo simulazione)',byopDesc:'Modello automatico. Inserisci chiave sk_* da enter.pollinations.ai/keys.',save:'Salva',test:'Testa',durasi:'Durata',history:'Cronologia',scrollTop:'Torna in alto',random:'Seme casuale'},
};

// For each language, find its block and add keys properly
for (const lang of langs) {
  const keys = newKeys[lang];
  const additions = Object.entries(keys)
    .map(([k, v]) => ',' + k + ":'" + v.replace(/'/g, "\\'") + "'")
    .join('');
  
  // Find the language block start
  const langPattern = `  ${lang}:{`;
  const langStart = c.indexOf(langPattern);
  if (langStart === -1) {
    console.log(`WARNING: Could not find start of ${lang} block`);
    continue;
  }
  
  // Find the closing '},' of this language block
  // We need to find the FIRST '},' after the language start that closes THIS block
  let depth = 0;
  let pos = langStart + langPattern.length;
  let blockEnd = -1;
  
  while (pos < c.length) {
    if (c[pos] === '{') depth++;
    else if (c[pos] === '}') {
      if (depth === 0) {
        // This is the closing brace of the language block
        blockEnd = pos;
        break;
      }
      depth--;
    }
    pos++;
  }
  
  if (blockEnd === -1) {
    console.log(`WARNING: Could not find closing of ${lang} block`);
    continue;
  }
  
  // Insert new keys before the closing '}'
  c = c.substring(0, blockEnd) + additions + c.substring(blockEnd);
  console.log(`Added keys to ${lang}`);
}

writeFileSync('index.html', c);

// Verify
let v = readFileSync('index.html', 'utf8');
console.log('\nVerification:');
console.log('data-t count:', (v.match(/data-t=/g) || []).length);
// Check that each lang has its own keys
langs.forEach(l => {
  let start = v.indexOf(`  ${l}:{`);
  let end = v.indexOf('},', start);
  let block = v.substring(start, end);
  let hasLoginByop = block.includes('loginByop:');
  let hasDurasi = block.includes('durasi:');
  console.log(`${l}: loginByop=${hasLoginByop?'OK':'MISSING'}, durasi=${hasDurasi?'OK':'MISSING'}`);
});
