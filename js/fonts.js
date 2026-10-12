// 文字入れで使えるフォント。web: true のものは Google Fonts（無料・OFL）から読み込む。
// 一度使ったフォントは Service Worker がキャッシュするので、次回からはオフラインでも使える。

export const FONTS = [
  { key: 'hira', label: 'ヒラギノ角ゴ', family: '"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif', weight: 700 },
  { key: 'noto', label: 'Noto Sans 極太', family: '"Noto Sans JP"', weight: 900, css: 'Noto+Sans+JP:wght@900' },
  { key: 'maru', label: 'M PLUS 丸ゴシック', family: '"M PLUS Rounded 1c"', weight: 800, css: 'M+PLUS+Rounded+1c:wght@800' },
  { key: 'dela', label: 'デラゴシック', family: '"Dela Gothic One"', weight: 400, css: 'Dela+Gothic+One' },
  { key: 'mochiy', label: 'もちっとポップ', family: '"Mochiy Pop One"', weight: 400, css: 'Mochiy+Pop+One' },
  { key: 'rock', label: 'ロックンロール', family: '"RocknRoll One"', weight: 400, css: 'RocknRoll+One' },
  { key: 'reggae', label: 'レゲエ', family: '"Reggae One"', weight: 400, css: 'Reggae+One' },
  { key: 'zenmaru', label: 'Zen 丸ゴシック', family: '"Zen Maru Gothic"', weight: 900, css: 'Zen+Maru+Gothic:wght@900' },
  { key: 'mincho', label: '明朝 極太', family: '"Noto Serif JP"', weight: 900, css: 'Noto+Serif+JP:wght@900' },
  { key: 'yusei', label: '手書き風', family: '"Yusei Magic"', weight: 400, css: 'Yusei+Magic' },
  { key: 'dot', label: 'ドット', family: '"DotGothic16"', weight: 400, css: 'DotGothic16' },
  { key: 'kiwi', label: 'キウイ丸', family: '"Kiwi Maru"', weight: 500, css: 'Kiwi+Maru:wght@500' },
  { key: 'anton', label: 'Anton (英)', family: '"Anton"', weight: 400, css: 'Anton' },
  { key: 'bebas', label: 'Bebas Neue (英)', family: '"Bebas Neue"', weight: 400, css: 'Bebas+Neue' },
  { key: 'bangers', label: 'Bangers (英)', family: '"Bangers"', weight: 400, css: 'Bangers' },
  { key: 'montserrat', label: 'Montserrat (英)', family: '"Montserrat"', weight: 900, css: 'Montserrat:wght@900' },
  { key: 'marker', label: 'Marker (英)', family: '"Permanent Marker"', weight: 400, css: 'Permanent+Marker' },
];

export const fontByKey = (key) => FONTS.find((f) => f.key === key) || FONTS[0];

export const fontString = (key, px) => {
  const f = fontByKey(key);
  return `${f.weight} ${px}px ${f.family}`;
};

let cssAdded = false;
// Google Fonts の CSS を1回だけ追加する。日本語フォントは文字ごとに分割されているので、
// 実際のフォントデータは ensureFont() で使う文字の分だけ読み込まれる。
export function addFontCss() {
  if (cssAdded) return;
  cssAdded = true;
  const fams = FONTS.filter((f) => f.css).map((f) => 'family=' + f.css).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${fams}&display=swap`;
  document.head.appendChild(link);
}

// 指定したフォントで text を描くのに必要なデータを読み込む。オフラインなどで失敗しても例外にしない
export async function ensureFont(key, text) {
  const f = fontByKey(key);
  if (!f.css || !document.fonts) return true;
  try {
    const list = await document.fonts.load(`${f.weight} 40px ${f.family}`, text || 'あA');
    return list.length > 0;
  } catch {
    return false;
  }
}
