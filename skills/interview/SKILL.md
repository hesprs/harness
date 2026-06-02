---
name: interview
description: Clarify user intents by asking questions. Use only when user instructs or other skill references.
---

- Deep dive into the implementation of the described feature / refactor, discover every un-described decision that makes difference. Ask the user for clarification.
- Ask **one question at a time** to refine purpose, constraints, and success criteria. Don't guess the user's intent.
- Prefer multiple-choice questions where possible; open-ended is acceptable when necessary.
- Only advance when the current question is answered. If a topic requires deeper exploration, break it into sequential questions.

#### Validation

Find sharp contradictions, logic flaws, and perceived heavy lifting that impede implementation, and ask for clarification or blueprint revise. "This is infeasible since X ..., tons of changes (list changes) are needed and the goal won't be achieved since X still ...".

#### Challenge against the glossary

When the user uses a term that conflicts with the existing language in the blueprint, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

#### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

#### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

#### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"
