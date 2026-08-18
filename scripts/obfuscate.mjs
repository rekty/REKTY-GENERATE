/**
 * Obfuscate index.html — extract <script>, obfuscate JS, re-insert.
 * Usage: node scripts/obfuscate.mjs
 *
 * WARNING: Obfuscation makes code HARDER to read, not impossible.
 * A determined attacker can still reverse-engineer it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'index.html');
const distDir = resolve(root, 'dist');
const out = resolve(distDir, 'index.html');

const JavaScriptObfuscator = (await import('javascript-obfuscator')).default;

const html = readFileSync(src, 'utf-8');

// Anti-devtools code (prepended to main script)
const antiDevTools = `
(function(){
  function _ck(){
    var w=window,d=document;
    if(w.outerWidth-w.innerWidth>160||w.outerHeight-w.innerHeight>160){
      d.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:20px"><div><p>Developer Tools detected.</p><p style="color:#666;font-size:14px;margin-top:8px">This app does not allow inspection.</p></div></div>';
      d.title='Access Denied';
      throw new Error('DevTools');
    }
  }
  setInterval(_ck,800);
  window.console={log:function(){},warn:function(){},error:function(){},info:function(){},debug:function(){},clear:function(){},table:function(){},group:function(){},groupEnd:function(){},time:function(){},timeEnd:function(){},count:function(){},assert:function(){},dir:function(){},trace:function(){},profile:function(){},profileEnd:function(){}};
})();
`;

// Process HTML line by line — find <script> blocks
const scriptTagStart = /<script(?:\s[^>]*)?>/gi;
let result = '';
let pos = 0;
let scriptCount = 0;

while (pos < html.length) {
  scriptTagStart.lastIndex = pos;
  const tagMatch = scriptTagStart.exec(html);

  if (!tagMatch) {
    result += html.slice(pos);
    break;
  }

  const tagStart = tagMatch.index;
  const tagEnd = tagMatch.index + tagMatch[0].length;

  // Check if this is an external script (has src=)
  if (/src\s*=/i.test(tagMatch[0])) {
    result += html.slice(pos, tagEnd);
    pos = tagEnd;
    continue;
  }

  // Find closing </script>
  const closeIdx = html.indexOf('</script>', tagEnd);
  if (closeIdx === -1) {
    result += html.slice(pos);
    break;
  }

  const scriptContent = html.slice(tagEnd, closeIdx).trim();
  result += html.slice(pos, tagEnd);

  if (scriptContent.length > 1000) {
    // Main script — obfuscate
    const content = (scriptCount === 0 ? antiDevTools : '') + scriptContent;

    const obfuscated = JavaScriptObfuscator.obfuscate(content, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.3,
      deadCodeInjection: false,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      selfDefending: false,
      simplify: true,
      stringArray: true,
      stringArrayCallsTransform: false,
      stringArrayEncoding: [],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 1,
      stringArrayWrappersChainedCalls: false,
      stringArrayWrappersParametersMaxCount: 2,
      stringArrayWrappersType: 'function',
      stringArrayThreshold: 0.75,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      reservedNames: ['^\\$'],
      target: 'browser'
    });

    result += obfuscated.getObfuscatedCode();
    scriptCount++;
  } else {
    // Small script — keep as-is
    result += scriptContent;
  }

  result += '</script>';
  pos = closeIdx + 9; // length of '</script>'
}

// Ensure dist directory exists
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

writeFileSync(out, result, 'utf-8');

const srcSize = (Buffer.byteLength(html) / 1024).toFixed(1);
const outSize = (Buffer.byteLength(result) / 1024).toFixed(1);
console.log(`Obfuscated ${scriptCount} script blocks`);
console.log(`  Source: ${srcSize} KB -> Output: ${outSize} KB`);
console.log(`  Written to: ${out}`);
