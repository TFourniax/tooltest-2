export async function readHookPayload(stream = process.stdin) {
  let raw = '';
  const decoder = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true});
  try {
    for await (const chunk of stream) {
      raw += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream:true});
    }
    raw += decoder.decode();
    return raw.trim() ? JSON.parse(raw) : {};
  }
  catch { return {}; }
}
