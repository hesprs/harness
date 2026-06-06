---
name: query-docs
description: Retrieve documentation for any library, framework, and components. Use when deal with unfamiliar libraries or research a tool in depth.
---

# Context7

## Workflow

### Step 1: Search for the Library

To find the Context7 library ID, query with `read` tool:

```
https://context7.com/api/v2/libs/search?libraryName=LIBRARY_NAME&query=TOPIC
```

**Parameters:**

- `libraryName` (required): The library name to search for (e.g., "react", "nextjs", "fastapi", "axios")
- `query` (required): A description of the topic for relevance ranking

**Response fields:**

- `id`: Library identifier for the context endpoint (e.g., `/websites/react_dev_reference`)
- `title`: Human-readable library name
- `description`: Brief description of the library
- `totalSnippets`: Number of documentation snippets available

### Step 2: Fetch Documentation

To retrieve documentation, use the library ID from step 1, read:

```
https://context7.com/api/v2/context?libraryId=LIBRARY_ID&query=TOPIC&type=txt
```

**Parameters:**

- `libraryId` (required): The library ID from search results
- `query` (required): The specific topic to retrieve documentation for
- `type` (optional): Response format - `json` (default) or `txt` (plain text, more readable)

## Examples

### Next.js routing documentation

```
# Find Next.js library ID
https://context7.com/api/v2/libs/search?libraryName=nextjs&query=routing

# Fetch app router documentation
https://context7.com/api/v2/context?libraryId=/vercel/next.js&query=app+router&type=txt
```

### FastAPI dependency injection

```
# Find FastAPI library ID
https://context7.com/api/v2/libs/search?libraryName=fastapi&query=dependencies

# Fetch dependency injection documentation
https://context7.com/api/v2/context?libraryId=/fastapi/fastapi&query=dependency+injection&type=txt
```

## Tips

- Use `type=txt` for more readable output
- Be specific with the `query` parameter to improve relevance ranking
- If the first search result is not correct, check additional results in the array
- URL-encode query parameters containing spaces (use `+` or `%20`)
