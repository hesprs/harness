---
name: write-tests
description: Defines test standards. Must use before writing any test code.
---

# Write tests

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.
**Your work**: Write requested tests with respect to the styles below.

## Phasing

Tests should be written right after public interfaces are fixed, but no real implementation are made. **Recommended: write stubs to pin down the file structure and public interfaces, then tests, then concrete implementation**.

- Anti-pattern 1: test after logic is writing mould passing your own code. No bugs can be caught.
- Anti-pattern 2: test without public interface making you hallucinate the API. If you are asked to write tests without it, reject immediately.

## Testing Style

### Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
// GOOD: Tests observable behavior
test('user can checkout with valid cart', async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe('confirmed');
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test
- Flat top-level `test()` inside test files instead of nested `describe()` and `it()`.

### Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test('checkout calls paymentService.process', async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```typescript
// BAD: Bypasses interface to verify
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' });
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice']);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe('Alice');
});
```

## Mocking Style

Mock at **system boundaries** only:

- External APIs (payment, email, stub deps, etc. If it is a dependency package to be mocked, prefer mocking full interface in a central file instead of mocking in each file)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Checklist When Finish

- [ ] Test describes behavior, not implementation
- [ ] Test uses public interface only
- [ ] Test would survive internal refactor
- [ ] Test code is minimal
- [ ] No speculative features added
