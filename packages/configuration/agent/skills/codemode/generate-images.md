```ts
interface ImagesContext {
  /** The prompt as text blocks, plus image blocks to edit or use as references. */
  input: (TextBlock | ImageBlock)[];
}

interface ImagesResult {
  provider: string;
  model: string;
  /** Generated images, and text blocks for models that also return text. */
  output: (TextBlock | ImageBlock)[];
  usage?: ModelUsage;
  stopReason: 'stop' | 'error' | 'aborted';
  errorMessage?: string;
}

type TextBlock = { type: 'text'; text: string };
/** `data` is base64. */
type ImageBlock = { type: 'image'; data: string; mimeType: string };
```

Show generated images with `image(block)`. Do not print `data` with `text()`, `console`, or `return`: it is large and the model cannot read it as text. `image()` also saves each image to a temp file and puts its path in the result, so a later turn can copy or move the file.

```js
// @options: {"timeout_ms": 300000}
const painter = await models.getModelOfType('image', 'openrouter', 'google/gemini-2.5-flash-image');
const result = await models.generateImages(painter, {
  input: [{ type: 'text', text: 'A red fox in the snow, watercolor' }],
});
if (result.stopReason !== 'stop') return result.errorMessage;
for (const block of result.output) {
  if (block.type === 'image') image(block);
  else text(block.text);
}
```
