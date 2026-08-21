import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('index.html', 'utf8');

// Step 1: Add data-t attributes to HTML elements
const htmlReplacements = [
  // Provider label
  ['<label class="text-[11px] text-neutral-500">Provider</label>', '<label class="text-[11px] text-neutral-500" data-t="provider">Provider</label>'],
  // Login Pollinations label
  ['<label class="text-[11px] text-neutral-500">Login Pollinations</label>', '<label class="text-[11px] text-neutral-500" data-t="loginPollinations">Login Pollinations</label>'],
  // BYOP login button - wrap text in span with data-t
  ['Login dengan Pollinations (BYOP)</button>', '<span data-t="loginByop">Login dengan Pollinations (BYOP)</span></button>'],
  // Mode label
  ['<label class="text-[11px] text-neutral-500">Mode</label>', '<label class="text-[11px] text-neutral-500" data-t="modeLabel">Mode</label>'],
  // Demo option
  ['<option value="demo">Demo (simulasi saja)</option>', '<option value="demo" data-t="demoMode">Demo (simulasi saja)</option>'],
  // Save button
  ['<button id="api-save" class="btn btn-ghost flex-1 h-8 border bd text-xs">Simpan</button>', '<button id="api-save" class="btn btn-ghost flex-1 h-8 border bd text-xs" data-t="save">Simpan</button>'],
  // Test button
  ['<button id="api-test" class="btn btn-ghost flex-1 h-8 border bd text-xs">Tes</button>', '<button id="api-test" class="btn btn-ghost flex-1 h-8 border bd text-xs" data-t="test">Tes</button>'],
];

for (const [old, rep] of htmlReplacements) {
  if (c.includes(old)) {
    c = c.replace(old, rep);
    console.log('HTML replaced:', old.substring(0, 40));
  } else {
    console.log('HTML NOT FOUND:', old.substring(0, 40));
  }
}

// Step 2: Add new translation keys to EACH language block
// We need to add: loginPollinations, loginByop, modeLabel, realApi, demoMode, byopDesc, save, test
const translations = {
  id: {loginPollinations:'Login Pollinations',loginByop:'Login dengan Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (wajib backend)',demoMode:'Demo (simulasi saja)',byopDesc:'Model otomatis. Isi key sk_* dari enter.pollinations.ai/keys untuk daftar model lengkap. Hasil otomatis diarsip permanen.',save:'Simpan',test:'Tes'},
  en: {loginPollinations:'Login Pollinations',loginByop:'Login with Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (backend required)',demoMode:'Demo (simulation only)',byopDesc:'Auto model. Enter sk_* key from enter.pollinations.ai/keys for full model list. Results auto-archived permanently.',save:'Save',test:'Test'},
  ja: {loginPollinations:'Pollinations ログイン',loginByop:'Pollinations でログイン (BYOP)',modeLabel:'モード',realApi:'リアル API (バックエンド必須)',demoMode:'デモ (シミュレーションのみ)',byopDesc:'自動モデル。enter.pollinations.ai/keys から sk_* キーを入力して全モデルリストを取得。結果は自動永久アーカイブ。',save:'保存',test:'テスト'},
  ko: {loginPollinations:'Pollinations 로그인',loginByop:'Pollinations으로 로그인 (BYOP)',modeLabel:'모드',realApi:'실제 API (백엔드 필수)',demoMode:'데모 (시뮬레이션만)',byopDesc:'자동 모델. enter.pollinations.ai/keys에서 sk_* 키를 입력하여 전체 모델 목록을 가져옵니다.',save:'저장',test:'테스트'},
  zh: {loginPollinations:'Pollinations 登录',loginByop:'使用 Pollinations 登录 (BYOP)',modeLabel:'模式',realApi:'真实 API (需要后端)',demoMode:'演示 (仅模拟)',byopDesc:'自动模型。从 enter.pollinations.ai/keys 输入 sk_* 密钥获取完整模型列表。',save:'保存',test:'测试'},
  es: {loginPollinations:'Iniciar sesión Pollinations',loginByop:'Iniciar con Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (requiere backend)',demoMode:'Demo (solo simulación)',byopDesc:'Modelo automático. Ingresa clave sk_* de enter.pollinations.ai/keys para lista completa.',save:'Guardar',test:'Probar'},
  fr: {loginPollinations:'Connexion Pollinations',loginByop:'Se connecter avec Pollinations (BYOP)',modeLabel:'Mode',realApi:'API Réel (backend requis)',demoMode:'Démo (simulation uniquement)',byopDesc:'Modèle automatique. Entrez la clé sk_* de enter.pollinations.ai/keys pour la liste complète.',save:'Enregistrer',test:'Tester'},
  de: {loginPollinations:'Pollinations anmelden',loginByop:'Mit Pollinations anmelden (BYOP)',modeLabel:'Modus',realApi:'Echte API (Backend erforderlich)',demoMode:'Demo (nur Simulation)',byopDesc:'Automatisches Modell. Geben Sie sk_* Schlüssel von enter.pollinations.ai/keys ein.',save:'Speichern',test:'Testen'},
  pt: {loginPollinations:'Login Pollinations',loginByop:'Login com Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (backend necessário)',demoMode:'Demo (apenas simulação)',byopDesc:'Modelo automático. Insira chave sk_* de enter.pollinations.ai/keys para lista completa.',save:'Salvar',test:'Testar'},
  ru: {loginPollinations:'Вход Pollinations',loginByop:'Войти через Pollinations (BYOP)',modeLabel:'Режим',realApi:'Настоящий API (требуется бэкенд)',demoMode:'Демо (только симуляция)',byopDesc:'Автоматическая модель. Введите sk_* ключ с enter.pollinations.ai/keys.',save:'Сохранить',test:'Тест'},
  ar: {loginPollinations:'تسجيل دخول Pollinations',loginByop:'تسجيل الدخول عبر Pollinations (BYOP)',modeLabel:'الوضع',realApi:'API حقيقي (يتطلب خلفية)',demoMode:'عرض (محاكاة فقط)',byopDesc:'نموذج تلقائي. أدخل مفتاح sk_* من enter.pollinations.ai/keys.',save:'حفظ',test:'اختبار'},
  hi: {loginPollinations:'Pollinations लॉगिन',loginByop:'Pollinations से लॉगिन करें (BYOP)',modeLabel:'मोड',realApi:'असली API (बैकएंड आवश्यक)',demoMode:'डेमो (केवल सिमुलेशन)',byopDesc:'स्वचालित मॉडल। enter.pollinations.ai/keys से sk_* कुंजी दर्ज करें।',save:'सहेजें',test:'परीक्षण'},
  th: {loginPollinations:'เข้าสู่ระบบ Pollinations',loginByop:'เข้าสู่ระบบด้วย Pollinations (BYOP)',modeLabel:'โหมด',realApi:'API จริง (ต้องการ backend)',demoMode:'สาธิต (จำลองเท่านั้น)',byopDesc:'โมเดลอัตโนมัติ ป้อนคีย์ sk_* จาก enter.pollinations.ai/keys',save:'บันทึก',test:'ทดสอบ'},
  vi: {loginPollinations:'Đăng nhập Pollinations',loginByop:'Đăng nhập với Pollinations (BYOP)',modeLabel:'Chế độ',realApi:'API Thực (cần backend)',demoMode:'Demo (chỉ mô phỏng)',byopDesc:'Model tự động. Nhập sk_* key từ enter.pollinations.ai/keys.',save:'Lưu',test:'Kiểm tra'},
  tr: {loginPollinations:'Pollinations Girişi',loginByop:'Pollinations ile Giriş (BYOP)',modeLabel:'Mod',realApi:'Gerçek API (backend gerekli)',demoMode:'Demo (yalnızca simülasyon)',byopDesc:'Otomatik model. enter.pollinations.ai/keys adresinden sk_* anahtarını girin.',save:'Kaydet',test:'Test'},
  pl: {loginPollinations:'Logowanie Pollinations',loginByop:'Zaloguj się przez Pollinations (BYOP)',modeLabel:'Tryb',realApi:'Prawdziwe API (wymagany backend)',demoMode:'Demo (tylko symulacja)',byopDesc:'Automatyczny model. Wprowadź klucz sk_* z enter.pollinations.ai/keys.',save:'Zapisz',test:'Testuj'},
  nl: {loginPollinations:'Pollinations Inloggen',loginByop:'Inloggen met Pollinations (BYOP)',modeLabel:'Modus',realApi:'Echte API (backend vereist)',demoMode:'Demo (alleen simulatie)',byopDesc:'Automatisch model. Voer sk_* sleutel in van enter.pollinations.ai/keys.',save:'Opslaan',test:'Testen'},
  it: {loginPollinations:'Accesso Pollinations',loginByop:'Accedi con Pollinations (BYOP)',modeLabel:'Modalità',realApi:'API Reale (backend necessario)',demoMode:'Demo (solo simulazione)',byopDesc:'Modello automatico. Inserisci chiave sk_* da enter.pollinations.ai/keys.',save:'Salva',test:'Testa'},
};

// For each language, find its block and add new keys before the closing
for (const [lang, keys] of Object.entries(translations)) {
  const additions = Object.entries(keys)
    .map(([k, v]) => ',' + k + ":'" + v.replace(/'/g, "\\'") + "'")
    .join('');
  
  // Find the pattern: lang:{...noTriggerWords:'...'}
  // The last key in each block is noTriggerWords
  const re = new RegExp(`(${lang}:[^{]*\\{[^}]*?noTriggerWords:'[^']*')`);
  if (re.test(c)) {
    c = c.replace(re, '$1' + additions);
    console.log(`Added keys to ${lang}`);
  } else {
    console.log(`WARNING: Could not find ${lang}`);
  }
}

writeFileSync('index.html', c);

// Verify
let v = readFileSync('index.html', 'utf8');
console.log('\nVerification:');
console.log('data-t count:', (v.match(/data-t=/g) || []).length);
console.log('loginByop count:', (v.match(/loginByop:/g) || []).length);
console.log('demoMode count:', (v.match(/demoMode:/g) || []).length);
