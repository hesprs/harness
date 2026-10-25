```ts
interface ClassifierContext {
  /** The data to classify. */
  state: Record<string, unknown>;
  /** Images judged together with `state`. Only models whose `input` includes "image" accept them. */
  images?: { type: 'image'; data: string; mimeType: string }[];
  /** Questions by ID. One call answers all of them. */
  questions: Record<string, ClassifierQuestion>;
}

type ClassifierQuestion =
  /** Pick one label. `criteria` maps each label to what it means. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  /** Score on an ordered scale. `criteria` describes each level, lowest first. */
  | { type: 'score'; instructions: string; criteria: string[] }
  /** Yes or no. */
  | { type: 'bool'; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  provider: string;
  model: string;
  /** Answers by question ID. */
  answers: Record<string, ClassifierAnswer>;
  usage?: ModelUsage;
  stopReason: 'stop' | 'error' | 'aborted';
  errorMessage?: string;
}

type ClassifierAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is the expected level index, from 0 to `criteria.length - 1`. */
  | { type: 'score'; score: number; confidence: number }
  /** Probability of `true`. */
  | { type: 'bool'; probability: number };

/** Token counts and cost in USD, when the service reports them. */
type ModelUsage = { input: number; output: number; totalTokens: number; cost: { total: number } };
```

Classify several items by calling `classify()` once per item. This script sorts feedback messages, for example ones a tool returned earlier in the script:

```js
const jev = await models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const results = await Promise.all(
  messages.map((message) =>
    models.classify(jev, {
      state: { message },
      questions: {
        sentiment: {
          type: 'choice',
          instructions: 'How does the user feel about the product?',
          criteria: {
            positive: 'Satisfied or happy',
            negative: 'Unhappy or frustrated',
            neutral: 'Neither',
          },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgently does this need a reply?',
          criteria: ['no reply needed', 'reply this week', 'reply today'],
        },
      },
    }),
  ),
);
return results.map((result, i) =>
  result.stopReason === 'stop'
    ? {
        message: messages[i],
        sentiment: result.answers.sentiment.choice,
        urgency: result.answers.urgency.score,
      }
    : { message: messages[i], error: result.errorMessage },
);
```

Classifiers whose `input` includes `"image"` also judge images. `tools.read()` returns an image file as an image block that `images` accepts. Other classifiers return an error result when `images` is not empty.

```js
const luna = await models.getModelOfType('classifier', 'openai', 'gpt-6-luna');
const photo = await tools.read({ path: 'screenshot.png' });
const result = await models.classify(luna, {
  state: { task: 'Settings page redesign' },
  images: [photo],
  questions: {
    broken: {
      type: 'bool',
      instructions: 'Does the screenshot show a broken layout?',
      criteria: { true: 'Overlapping, cut-off, or misaligned elements', false: 'Clean layout' },
    },
  },
});
```
