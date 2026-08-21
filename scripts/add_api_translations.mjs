import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('index.html', 'utf8');

const newKeys = {
  id: {loginPollinations:'Login Pollinations',loginByop:'Login dengan Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (wajib backend)',autoMode:'Auto (backend → demo)',demoMode:'Demo (simulasi saja)',byopDesc:'Model otomatis. Isi key sk_* dari enter.pollinations.ai/keys untuk daftar model lengkap. Hasil otomatis diarsip permanen.',test:'Tes'},
  en: {loginPollinations:'Login Pollinations',loginByop:'Login with Pollinations (BYOP)',modeLabel:'Mode',realApi:'Real API (backend required)',autoMode:'Auto (backend → demo)',demoMode:'Demo (simulation only)',byopDesc:'Auto model. Enter sk_* key from enter.pollinations.ai/keys for full model list. Results auto-archived permanently.',test:'Test'},
  ja: {loginPollinations:'Pollinations ログイン',loginByop:'Pollinations でログイン (BYOP)',modeLabel:'モード',realApi:'リアル API (バックエンド必須)',autoMode:'自動 (バックエンド → デモ)',demoMode:'デモ (シミュレーションのみ)',byopDesc:'自動モデル。enter.pollinations.ai/keys から sk_* キーを入力して全モデルリストを取得。結果は自動永久アーカイブ。',test:'テスト'},
  ko: {loginPollinations:'Pollinations 로그인',loginByop:'Pollinations으로 로그인 (BYOP)',modeLabel:'모드',realApi:'실제 API (백엔드 필수)',autoMode:'자동 (백엔드 → 데모)',demoMode:'데모 (시뮬레이션만)',byopDesc:'자동 모델. enter.pollinations.ai/keys에서 sk_* 키를 입력하여 전체 모델 목록을 가져옵니다. 결과는 자동 영구 보관.',test:'테스트'},
  zh: {loginPollinations:'Pollinations 登录',loginByop:'使用 Pollinations 登录 (BYOP)',modeLabel:'模式',realApi:'真实 API (需要后端)',autoMode:'自动 (后端 → 演示)',demoMode:'演示 (仅模拟)',byopDesc:'自动模型。从 enter.pollinations.ai/keys 输入 sk_* 密钥获取完整模型列表。结果自动永久归档。',test:'测试'},
  es: {loginPollinations:'Iniciar sesión Pollinations',loginByop:'Iniciar con Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (requiere backend)',autoMode:'Auto (backend → demo)',demoMode:'Demo (solo simulación)',byopDesc:'Modelo automático. Ingresa clave sk_* de enter.pollinations.ai/keys para lista completa. Resultados archivados permanentemente.',test:'Probar'},
  fr: {loginPollinations:'Connexion Pollinations',loginByop:'Se connecter avec Pollinations (BYOP)',modeLabel:'Mode',realApi:'API Réel (backend requis)',autoMode:'Auto (backend → démo)',demoMode:'Démo (simulation uniquement)',byopDesc:'Modèle automatique. Entrez la clé sk_* de enter.pollinations.ai/keys pour la liste complète. Résultats archivés permanemment.',test:'Tester'},
  de: {loginPollinations:'Pollinations anmelden',loginByop:'Mit Pollinations anmelden (BYOP)',modeLabel:'Modus',realApi:'Echte API (Backend erforderlich)',autoMode:'Auto (Backend → Demo)',demoMode:'Demo (nur Simulation)',byopDesc:'Automatisches Modell. Geben Sie sk_* Schlüssel von enter.pollinations.ai/keys ein für vollständige Modelliste. Ergebnisse automatisch archiviert.',test:'Testen'},
  pt: {loginPollinations:'Login Pollinations',loginByop:'Login com Pollinations (BYOP)',modeLabel:'Modo',realApi:'API Real (backend necessário)',autoMode:'Auto (backend → demo)',demoMode:'Demo (apenas simulação)',byopDesc:'Modelo automático. Insira chave sk_* de enter.pollinations.ai/keys para lista completa. Resultados arquivados permanentemente.',test:'Testar'},
  ru: {loginPollinations:'Вход Pollinations',loginByop:'Войти через Pollinations (BYOP)',modeLabel:'Режим',realApi:'Настоящий API (требуется бэкенд)',autoMode:'Авто (бэкенд → демо)',demoMode:'Демо (только симуляция)',byopDesc:'Автоматическая модель. Введите sk_* ключ с enter.pollinations.ai/keys для полного списка. Результаты автоматически архивируются.',test:'Тест'},
  ar: {loginPollinations:'تسجيل دخول Pollinations',loginByop:'تسجيل الدخول عبر Pollinations (BYOP)',modeLabel:'الوضع',realApi:'API حقيقي (يتطلب خلفية)',autoMode:'تلقائي (خلفية → عرض)',demoMode:'عرض (محاكاة فقط)',byopDesc:'نموذج تلقائي. أدخل مفتاح sk_* من enter.pollinations.ai/keys لقائمة النماذج الكاملة. النتائج مؤرشفة تلقائيًا.',test:'اختبار'},
  hi: {loginPollinations:'Pollinations लॉगिन',loginByop:'Pollinations से लॉगिन करें (BYOP)',modeLabel:'मोड',realApi:'असली API (बैकएंड आवश्यक)',autoMode:'ऑटो (बैकएंड → डेमो)',demoMode:'डेमो (केवल सिमुलेशन)',byopDesc:'स्वचालित मॉडल। enter.pollinations.ai/keys से sk_* कुंजी दर्ज करें। परिणाम स्वचालित रूप से संग्रहीत।',test:'परीक्षण'},
  th: {loginPollinations:'เข้าสู่ระบบ Pollinations',loginByop:'เข้าสู่ระบบด้วย Pollinations (BYOP)',modeLabel:'โหมด',realApi:'API จริง (ต้องการ backend)',autoMode:'อัตโนมัติ (backend → สาธิต)',demoMode:'สาธิต (จำลองเท่านั้น)',byopDesc:'โมเดลอัตโนมัติ ป้อนคีย์ sk_* จาก enter.pollinations.ai/keys สำหรับรายการโมเดลทั้งหมด ผลลัพธ์เก็บถาวรอัตโนมัติ',test:'ทดสอบ'},
  vi: {loginPollinations:'Đăng nhập Pollinations',loginByop:'Đăng nhập với Pollinations (BYOP)',modeLabel:'Chế độ',realApi:'API Thực (cần backend)',autoMode:'Tự động (backend → demo)',demoMode:'Demo (chỉ mô phỏng)',byopDesc:'Model tự động. Nhập sk_* key từ enter.pollinations.ai/keys để danh sách đầy đủ. Kết quả tự động lưu trữ vĩnh viễn.',test:'Kiểm tra'},
  tr: {loginPollinations:'Pollinations Girişi',loginByop:'Pollinations ile Giriş (BYOP)',modeLabel:'Mod',realApi:'Gerçek API (backend gerekli)',autoMode:'Otomatik (backend → demo)',demoMode:'Demo (yalnızca simülasyon)',byopDesc:'Otomatik model. enter.pollinations.ai/keys adresinden sk_* anahtarını girin. Sonuçlar otomatik kalıcı arşivlenir.',test:'Test'},
  pl: {loginPollinations:'Logowanie Pollinations',loginByop:'Zaloguj się przez Pollinations (BYOP)',modeLabel:'Tryb',realApi:'Prawdziwe API (wymagany backend)',autoMode:'Automatyczny (backend → demo)',demoMode:'Demo (tylko symulacja)',byopDesc:'Automatyczny model. Wprowadź klucz sk_* z enter.pollinations.ai/keys dla pełnej listy. Wyniki automatycznie archiwizowane.',test:'Testuj'},
  nl: {loginPollinations:'Pollinations Inloggen',loginByop:'Inloggen met Pollinations (BYOP)',modeLabel:'Modus',realApi:'Echte API (backend vereist)',autoMode:'Automatisch (backend → demo)',demoMode:'Demo (alleen simulatie)',byopDesc:'Automatisch model. Voer sk_* sleutel in van enter.pollinations.ai/keys voor volledige lijst. Resultaten automatisch gearchiveerd.',test:'Testen'},
  it: {loginPollinations:'Accesso Pollinations',loginByop:'Accedi con Pollinations (BYOP)',modeLabel:'Modalità',realApi:'API Reale (backend necessario)',autoMode:'Auto (backend → demo)',demoMode:'Demo (solo simulazione)',byopDesc:'Modello automatico. Inserisci chiave sk_* da enter.pollinations.ai/keys per lista completa. Risultati archiviati automaticamente.',test:'Testa'}
};

for (const [lang, keys] of Object.entries(newKeys)) {
  const additions = Object.entries(keys)
    .map(([k, v]) => ',' + k + ":'" + v.replace(/'/g, "\\'") + "'")
    .join('');
  
  const re = new RegExp(`(${lang}:[^{]*\\{[^}]*?noTriggerWords:'[^']*')`);
  if (re.test(c)) {
    c = c.replace(re, '$1' + additions);
    console.log(`Added API keys to ${lang}`);
  } else {
    console.log(`WARNING: Could not find ${lang} block`);
  }
}

writeFileSync('index.html', c);

// Verify
let v = readFileSync('index.html', 'utf8');
console.log('loginPollinations count:', (v.match(/loginPollinations:/g) || []).length);
console.log('test key count:', (v.match(/test:'/g) || []).length);
