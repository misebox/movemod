// bun build --compile 用。oxc-parser のネイティブバイナリを実行ファイルに埋め込み、その場所を oxc-parser に伝える。
// oxc-parser より先に読み込むこと
import binding from '@oxc-parser/binding-darwin-arm64/parser.darwin-arm64.node' with { type: 'file' };

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
