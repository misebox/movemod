// コメントと末尾のカンマを許す JSON（tsconfig 用）
export const parseJsonc = (text: string): unknown => {
  const length = text.length;
  let out = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < length) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < length && text[i] !== '\n') i++;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 2;
    } else if (char === ',') {
      let next = i + 1;
      while (next < length && /\s/.test(text[next])) next++;
      if (text[next] !== '}' && text[next] !== ']') out += char;
      i++;
    } else {
      out += char;
      i++;
    }
  }
  return JSON.parse(out);
};
