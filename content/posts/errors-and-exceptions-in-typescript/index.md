---
title: "Errors and Exceptions in TypeScript"
date: 2026-01-29
draft: false
tags: ["TypeScript", "Errors", "Exceptions"]
---

Errors and Exceptions are one of the most important matters when dealing with any language;
But sincerelly I don't know if it's just my experience but it is a pretty nebulous and neglected topic which people don't seems to give much attention, at least not the appropriate attention.
This is the motivation behind this article, to better understand what these objects are, how to handle them and some interesting design patterns.

## What they are

Errors are just regular objects which on its root inherits from the base Object class (the class whose _all_ other **objects** inherits from). For example, the following code does nothing on its own:

```ts
    const err = new Error("Something broke"); // This is just data, it does nothing yet.
```

The magic whose stops the program happens on the handler, also known as try/catch block, which for itself does nothing too.

```ts
    try {
        err; // No return because these statements can only be user inside functions.
    } catch(e) {
        console.error(e);
    }
```

or

```ts
    try {
        (() => err)(); // Nothing happens.
    } catch(e) {
        console.error(e);
    }
```

Unless we set the _**throw**_ keyword:

```ts
    try {
        throw err;
    } catch(e) {
        console.error(e); // 1 | const err = new Error("Something broke");
                          //             ^
                          // error: Something broke
    }
```

### The Throw Keyword

What effectivelly sends and object to the catch's _**e**_ callback argument is the _**throw**_ keyword; Ok, you shall already know it, but another interesting thing is that we can throw basically _any_ TypeScript value (strings, objects, numbers) on throw calls, the **Error** class our errors generally inherits from is just an object which presents the location of the error and a stack-trace for us; That is the primary reason we simply don't throw a **string**, for example.

```ts
    try {
        throw "Error!!!!"; // We lost the stack information!!
    } catch(e) {
        console.error(e); // "Error!!!!"
    }
```

Thats exactly what makes an Error !== from an Exception: Errors are just objects (which shall be handled on the application e,g. with pattern matching), on the otherside we have the Exceptions which is an specific _behavior_ of the language, is this case, which crashes our application.

This is the basics, now let's look at some interesting patterns and 'hidden' behaviors of them.

### Custom Errors

Errors from the try/catch block are typed as 'unknown'; That's precisely because we can throw anything in TypeScript. So in order to match specific errors we can match its message (whose isn't much scalable) or we can check the _instanceof_ the error. This way:

```ts
class ValidationError extends Error {
    constructor(public message: string, public field: string) {
        // Uses original Error constructor
        super(message);
        this.name = "ValidationError";
    }
}
```

And we can use it:

```ts
try {
    throw new ValidationError("Invalid field", "email");
} catch (err) {
    if (err instanceof ValidationError) {
        // Debug purpose, so we can check what the actual Error object looks like.
        // Has stack and cause fields too, inherited from the original Error class.
        // console.log(JSON.stringify(err));
        // console.log(err.stack);

        console.log(`Error in ${err.field}: ${err.message}`);
    }
}
```

We just created a class which inherits the behavior of the original error class and its fields, like the _stack_ field which shows the stack-trace information of the Error.

## The Result

One interesting pattern derived from functional programming is the _Result Pattern_. Which is basically a representation form (in this case an object) which represents either a Success<Data> or Error<Error> we can basically represent it like this:

```ts
// We could also extend E from Error class or assign a default type (E = Error) to get even more control over the error.
//
type Result<T, E> =
    | { success: true, data: T }
    | { success: false, error: E }
```

And use it:

```ts
class User {
    constructor(public id: number) {}
};

function getUser(id: number): Result<User, string> {
    if (id < 0) {
        return { success: false, error: "Invalid ID" };
    }

    return { success: true, data: new User(id) };
}

const result = getUser(-1);

if (result.success) {
    console.log("User: ", result.data);
} else {
    console.error(result.error)
}
```

Result is a powerful pattern used as first-class architectural choice in languages like Rust and functional ones, like Haskell.

## Nested Errors

Since ES2022, the Error constructor accepts an options object as argument; This allow us to 'wrap' and error inside another while preserving the original reason. They can be pretty useful when debbuging async nested calls. For example:

```ts
try {
    await database.connect();
} catch (err) {
    // You "wrap" the low-level DB error inside a high-level App error
    throw new Error("Failed to start server", { cause: err });
}
```

## Async Errors

There is also a special type of errors known as _**async errors**_. These errors are automatically thrown when a Promise is rejected and becomes a 'unhandledRejection' what crashes the Runtime. But it happens that the async API already comes with an decent error handler, which uses chained function calls in order to specify to the application should _react_ to these errors:

```ts
function loadData() {
  fetchUser(1)
    .then(user => processUser(user))
    .then(result => console.log("Done:", result))
    .catch(err => console.error("Caught at the end of the chain:", err));
}
```

Async errors can also be handled on try/catch block, but it can became messy and tricky very fast, once it is easy to have nested try/catch blocks mixed with business logic.

Another recurrent problem is the way async operations interacts with; I will first show three examples of common implementations which fails for the same reason:

```ts
try {
    // Expects a callback which receives an error
    throw fs.readFile("do-not-exist.txt", (err) => {
        return err;
    });

} catch (error) {
    console.log('called!', error);
}

// called! undefined

try {
    await fs.readFile("do-not-exist.txt", (err) => {
        throw err;
    });

} catch (error) {
    console.log('called!', error);
}

// called! undefined
// ENOENT: no such file or directory, open 'do-not-exist.txt'
//     path: "do-not-exist.txt",
//  syscall: "open",
//    errno: -2,
//     code: "ENOENT"

try {
    throw await fs.readFile("do-not-exist.txt", (err) => {
        throw err;
    });

} catch (error) {
    console.log('called!', error);
}

// called! undefined
// ENOENT: no such file or directory, open 'do-not-exist.txt'
//     path: "do-not-exist.txt",
//  syscall: "open",
//    errno: -2,
//     code: "ENOENT"
```

All of these blocks failed because the way Nodejs event-loop works. The try/catch is syncronous, what makes the throw in the first block just print a _undefined_ which is just what un-awaited promises returns. The exceptions are thrown on every block, but the try/catch block has been already executed, and the exception is thrown on void.

The catch here is to understand the Node APIs; We must use the fs from promises module, which in fact returns the _**Promise**_ we need. Like this:

```ts
// Import /promises is key
import fs from 'node:fs/promises';

try {
    const _data = await fs.readFile("do-not-exist.txt");
} catch(error) {
    console.error("Got the error! -- ", error);
}

```

If using a callback is mandatory, we must check for the error on the callback context, and do not throw it for outer blocks:

```ts
fs.readFile("do-not-exist.txt", (err, data) => {
    if (err) {
        console.log("Handle the error here, not in a catch block!");
        return;
    }
    console.log(data);
});
```

Handling async errors can look tricky at first glance, but it is just a matter of understand who must handle them and the options we have in order to do that.

## Furthermore

Now, I want to explore some extra-options we have when dealing with errors. We already saw the 'chaining' method on async approach. Now we are going to explore the **Higher-Order Function** approach.

### Higher-Order Functions

Higher-Order Functions are just functions whose returns other functions:

```ts
const wrap = (fn: Function) => (...args: any[]) => {
    return fn(...args).catch((err: Error) => {
        // Centralize log and error handling
        console.error("Global Logger: ", err.message);
    });
}

const deleteUser = wrap(async (id: number) => {
    const user = await database.find(id);
    await database.remove(user); // If it fails, 'wrap' handles it
});

await deleteUser(3);
```

This way we can wrap basically _any_ async function inside wrap, which returns our function which an 'automatic error handler', which is the **.catch([..])** call.

### Supervisors

On this approach we use Node's EventEmitter API in order to react to specific events (in this case 'error'), and handle them.

```ts
import { EventEmitter } from 'node:events';

const supervisor = new EventEmitter();
supervisor.on('error', (err) => {
    console.error("Supervisor handled: ", err);
});

async function saveFile(data: string) {
    if (!data) {
        supervisor.emit('error', new Error("No data provided"));
        return;
    }
    // ... further logic
}
```

### Bun

Finally, I want to show you which options the 'Bun' runtime gives us in order to handle errors.

Bun uses a centered approach, while still being compatible with try/catch blocks and all its machinery; Its approach differs from default API like where it assigns error handlers directly on the objects:

```ts
Bun.serve({
  fetch(req) {
    // If this throws, the 'error' function below catches it automatically
    throw new Error("Something went sideways!");
  },

  error(error) {
    // You can log to an external service here
    console.error("Server Error:", error.message);

    // Return a custom Response for the client
    return new Response("Custom Error Page", { status: 500 });
  },
});
```

And also has a non-throw approach, like the _**.file()**_ function:

```ts
const file = Bun.file("data.json");

// No error thrown if the file doesn't exist!
// It just returns false.
if (await file.exists()) {
  const data = await file.json();
} else {
  console.log("File missing, skipping...");
}
```

Which also counts with an process listener (like Node does):

```ts
// Handle unhandled promise rejections globally
process.on("unhandledRejection", (reason) => {
  console.error("You forgot to catch a promise somewhere:", reason);
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("The app is crashing! Saving logs...", err);
  process.exit(1);
});
```

## Last words

It is important to differ _**errors**_ from _**exceptions**_. While **errors** are inside our application domain, basically situations we can (and should) have a plan to catch and handle without crashing,
**exceptions** are external whose while out of our application domain, we can still handle them, like a database which won't connect; And even being handled they still can crash the application (e,g. for security/session integrity sake). For example: doesn't immediately drop all connections from server while still having valid data/request processing, when only one user had a CONNECTION_DB error.

Hope I have enlighted a bit your vision about errors and exceptions. On the final of the day, they are the same thing, most of the time represented by the same objects; What differ them is the _domain_ they act and how are handled. Feel free to leave a comment, CYA (!!).