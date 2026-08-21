import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('index.html', 'utf8');

const newKeys = {
  id: {models:'Models',addEmbedding:'Tambah Embedding',addControlNet:'Tambah ControlNet',negativeShort:'Negative',oneImage:'1 gambar',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Paste Data',noLora:'Belum ada LoRA',noTriggerWords:'Tidak ada trigger'},
  en: {models:'Models',addEmbedding:'Add Embedding',addControlNet:'Add ControlNet',negativeShort:'Negative',oneImage:'1 image',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Paste Data',noLora:'No LoRA yet',noTriggerWords:'No trigger words'},
  ja: {models:'モデル',addEmbedding:'埋め込み追加',addControlNet:'ControlNet追加',negativeShort:'ネガティブ',oneImage:'1枚',samplerLabel:'サンプラー',schedulerLabel:'スケジューラー',pasteGeneration:'データ貼り付け',noLora:'LoRAなし',noTriggerWords:'トリガーなし'},
  ko: {models:'모델',addEmbedding:'임베딩 추가',addControlNet:'ControlNet 추가',negativeShort:'네거티브',oneImage:'1장',samplerLabel:'샘플러',schedulerLabel:'스케줄러',pasteGeneration:'데이터 붙여넣기',noLora:'LoRA 없음',noTriggerWords:'트리거 없음'},
  zh: {models:'模型',addEmbedding:'添加嵌入',addControlNet:'添加ControlNet',negativeShort:'负面',oneImage:'1张',samplerLabel:'采样器',schedulerLabel:'调度器',pasteGeneration:'粘贴数据',noLora:'暂无LoRA',noTriggerWords:'无触发词'},
  es: {models:'Modelos',addEmbedding:'Añadir Embedding',addControlNet:'Añadir ControlNet',negativeShort:'Negativo',oneImage:'1 imagen',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Pegar Datos',noLora:'Sin LoRA',noTriggerWords:'Sin trigger words'},
  fr: {models:'Modèles',addEmbedding:'Ajouter Embedding',addControlNet:'Ajouter ControlNet',negativeShort:'Négatif',oneImage:'1 image',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Coller Données',noLora:'Pas de LoRA',noTriggerWords:'Pas de trigger words'},
  de: {models:'Modelle',addEmbedding:'Embedding hinzufügen',addControlNet:'ControlNet hinzufügen',negativeShort:'Negativ',oneImage:'1 Bild',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Daten einfügen',noLora:'Keine LoRA',noTriggerWords:'Keine Trigger-Wörter'},
  pt: {models:'Modelos',addEmbedding:'Adicionar Embedding',addControlNet:'Adicionar ControlNet',negativeShort:'Negativo',oneImage:'1 imagem',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Colar Dados',noLora:'Sem LoRA',noTriggerWords:'Sem trigger words'},
  ru: {models:'Модели',addEmbedding:'Добавить Embedding',addControlNet:'Добавить ControlNet',negativeShort:'Негатив',oneImage:'1 изображение',samplerLabel:'Сэмплер',schedulerLabel:'Планировщик',pasteGeneration:'Вставить данные',noLora:'Нет LoRA',noTriggerWords:'Нет триггерных слов'},
  ar: {models:'النماذج',addEmbedding:'إضافة Embedding',addControlNet:'إضافة ControlNet',negativeShort:'سلبي',oneImage:'1 صورة',samplerLabel:'العاينة',schedulerLabel:'المجدول',pasteGeneration:'لصق البيانات',noLora:'لا يوجد LoRA',noTriggerWords:'لا توجد كلمات محفزة'},
  hi: {models:'मॉडल',addEmbedding:'Embedding जोड़ें',addControlNet:'ControlNet जोड़ें',negativeShort:'नेगेटिव',oneImage:'1 चित्र',samplerLabel:'सैम्पलर',schedulerLabel:'शेड्यूलर',pasteGeneration:'डेटा पेस्ट करें',noLora:'कोई LoRA नहीं',noTriggerWords:'कोई ट्रिगर शब्द नहीं'},
  th: {models:'โมเดล',addEmbedding:'เพิ่ม Embedding',addControlNet:'เพิ่ม ControlNet',negativeShort:'เชิงลบ',oneImage:'1 รูป',samplerLabel:'ตัวสุ่ม',schedulerLabel:'ตัวจัดตาราง',pasteGeneration:'วางข้อมูล',noLora:'ยังไม่มี LoRA',noTriggerWords:'ไม่มีคำทริกเกอร์'},
  vi: {models:'Mô hình',addEmbedding:'Thêm Embedding',addControlNet:'Thêm ControlNet',negativeShort:'Âm',oneImage:'1 ảnh',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Dán dữ liệu',noLora:'Chưa có LoRA',noTriggerWords:'Không có trigger words'},
  tr: {models:'Modeller',addEmbedding:'Embedding Ekle',addControlNet:'ControlNet Ekle',negativeShort:'Negatif',oneImage:'1 görsel',samplerLabel:'Örnekleme',schedulerLabel:'Zamanlayıcı',pasteGeneration:'Veri Yapıştır',noLora:'LoRA yok',noTriggerWords:'Tetikleyici Kelime Yok'},
  pl: {models:'Modele',addEmbedding:'Dodaj Embedding',addControlNet:'Dodaj ControlNet',negativeShort:'Negatywny',oneImage:'1 obraz',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Wklej dane',noLora:'Brak LoRA',noTriggerWords:'Brak słów wyzwalaczy'},
  nl: {models:'Modellen',addEmbedding:'Embedding toevoegen',addControlNet:'ControlNet toevoegen',negativeShort:'Negatief',oneImage:'1 afbeelding',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Data plakken',noLora:'Geen LoRA',noTriggerWords:'Geen trigger woorden'},
  it: {models:'Modelli',addEmbedding:'Aggiungi Embedding',addControlNet:'Aggiungi ControlNet',negativeShort:'Negativo',oneImage:'1 immagine',samplerLabel:'Sampler',schedulerLabel:'Scheduler',pasteGeneration:'Incolla dati',noLora:'Nessuna LoRA',noTriggerWords:'Nessuna parola trigger'}
};

for (const [lang, keys] of Object.entries(newKeys)) {
  const additions = Object.entries(keys)
    .map(([k, v]) => ',' + k + ":'" + v.replace(/'/g, "\\'") + "'")
    .join('');
  
  // Find the reset:'...' entry in this language block and add after it
  const re = new RegExp(`(${lang}:[^{]*\\{[^}]*?reset:'[^']*')`);
  if (re.test(c)) {
    c = c.replace(re, '$1' + additions);
    console.log(`Added keys to ${lang}`);
  } else {
    console.log(`WARNING: Could not find ${lang} block`);
  }
}

writeFileSync('index.html', c);

// Verify
let v = readFileSync('index.html', 'utf8');
console.log('addEmbedding count:', (v.match(/addEmbedding:/g) || []).length);
console.log('oneImage count:', (v.match(/oneImage:/g) || []).length);
console.log('noLora count:', (v.match(/noLora:/g) || []).length);
