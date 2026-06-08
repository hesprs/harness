---
name: query-docs
description: Retrieve documentation for any library, framework, and components. Use when deal with unfamiliar libraries or research a tool in depth.
---

# Context7

## Workflow

### Step 1: Search for the Library

To find the Context7 library ID, use the search script:

```sh
bun path/to/skill/search-library.ts LIBRARY_NAME TOPIC
```

**Parameters:**

- `libraryName` (required): The library name to search for (e.g., "react", "nextjs", "fastapi", "axios")
- `query` (required): A description of the topic for relevance ranking
- `--type` / `-t` (optional): `json` (default) for structured output, `txt` for readable summary

**Response fields:**

- `id`: Library identifier for the context endpoint (e.g., `/facebook/react`), which will be used in next step
- `title`: Human-readable library name
- `description`: Brief description of the library
- `totalSnippets`: Number of documentation snippets available

### Step 2: Fetch Documentation

To retrieve documentation, use the fetch script with library ID from step 1:

```sh
bun path/to/skill/fetch-docs.ts LIBRARY_ID TOPIC
```

**Parameters:**

- `libraryId` (required): The library ID from search results
- `query` (required): The specific topic to retrieve documentation for
- `--type` / `-t` (optional): Response format - `txt` (default) or `json`

If you don't find desired doc info in one invocation, you can repeat this step many times with varying queries. You can also retry step 1 for a more relevant library.

## Examples

Next.js routing documentation:

```sh
# Find Next.js library ID
bun path/to/skill/search-library.ts nextjs routing

# Fetch app router documentation
bun path/to/skill/fetch-docs.ts /vercel/next.js "app router"
```

FastAPI dependency injection:

```sh
# Find FastAPI library ID
bun path/to/skill/search-library.ts fastapi dependencies

# Fetch dependency injection documentation
bun path/to/skill/fetch-docs.ts /fastapi/fastapi "dependency injection"
```

## Tips

- Be specific with the `query` parameter to improve relevance ranking
- If the first search result is not correct, check additional results in the array
- Use quoted args for multi-word queries
