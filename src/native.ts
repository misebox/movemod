// bun build --compile 用。oxc-parser のネイティブバイナリを実行ファイルに埋め込み、その場所を oxc-parser に伝える。
// 'native-binding' は scripts/build-bin.ts が、実行中の OS 用のファイルに解決する。oxc-parser より先に読み込むこと
import binding from 'native-binding' with { type: 'file' };

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
