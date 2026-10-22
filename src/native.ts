// For bun build --compile. Embeds the oxc-parser native binary in the executable and tells oxc-parser where it is.
// scripts/build-bin.ts resolves 'native-binding' to the file for the target OS. Must be imported before oxc-parser
import binding from 'native-binding' with { type: 'file' };

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
