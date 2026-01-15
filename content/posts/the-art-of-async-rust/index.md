---
title: "The Art of Async Rust"
date: 2026-01-13
draft: false
tags: ["rust", "async", "pin", "future"]
toc: true
---

> _Async is essentially the art of efficiently waiting for hardware interrupts._

On this article I explore how a strong-typed compiled language with strict memory rules makes sure async operations are possible and safe (can you spot how interesting it is?);
We are going to deep dive into the compiler async API and see basically how async runtimes works on Rust and what can they do, in a poignant way. We begin:

## Asyncronously Speaking

When dealing with async operations, we necessarily need to deal with some conventions (even if it's hidden from the programmer) to represent values that might not be available immediatelly; In Rust specifically:

- Poll Mechanism: We must be able to resolve the value eventually (e.g., by calling ```.await```): This represents a way to 'hook' into the result we're waiting for. And specifically means there's something looking at our computation, waiting, polling the operation for the result; An **Executor** (like _Tokio_) with an **Reactor** ── that pushes our computation forward by polling it.
- Stack Efficiency (Zero-Cost Abstraction): Unlike other languages where async values are forced onto the Heap, Rust Futures are just _state machines_ that can live entirely on the **Stack**.

That's where the Future enters, it is a trait which the object implementing this is forced to implement a ```poll()``` method, which expands itself into a _state machine_ at compile-time and interacts with an Executor (the state-machine handler), it is the API to deal with async operation Rust gives us. But it doesn't implement the **Executor** itself, that way we are free to choose our own async engine (or create one ourselves !!);

The idea of an async operation is basically to _'not block the entire power-line while you can process it on the side'_, this concept is expanded from hardware and kernel, as async runtimes have to orchestrate a lot of syscalls and states, like using ```epoll()``` or ```kqueue()```.

While '_asyncing_' in Rust we often don't need to implement the _Future_ trait manually, it is automatically resolved when we write something like:

```rust
async fn my_logic() {
    // Local variable
    let url = "https://[...]";

    // #1 Wait Point
    let data = get_data(url).await;

    // #2 Wait Point
    let transformed = transform_data(&data).await;
}
```

This is expanded into a _**state-machine**_ at compile-time, an ```Enum``` which contains each pause state of this function; It looks like this:

```rust
MyLogicEnum {
    // Hasn't started yet
    Unresumed,

    // Hold url if it's used later on the function (it could, but in this case it isn't)
    // and the returned Future from get_data() call.
    WaitingForData {
        url: String,
        child_future: GetDataFuture
    }

    WaitingForTransformData {
        // Data is consumed by transform_data, so no need to track it here, it is tracked inside the generated enum of TransformDataFuture (!!)
        child_future: TransformDataFuture
    }

    // All done (!!)
    Completed,
}
```

And this state-machine is advanced by the Future's ```poll()``` function, called by an **Executor**, which details we will see later on this article. Rust automatically creates a _state-machine_ representing the states of that async block, but here we write our own implementation, so the Enum is not created; _We are managing the state of the Future_.

> Note: This article sometimes use some features present on the _futures_ crate (made by the Rust Org team itself), what means sometimes you will see things like the _ArcWaker_ trait, be known that them relies on the _futures_ crate, and it is used for knowledge intuition and keep-this-article-scope sake.

## The Big-Picture

Let's begin visualizing the entire flow of a simple async request so we can explore it's concepts deeply later.
Here's the tiny program our analysis will be based on:

```rust
use std::{pin::Pin, task::{Context, Poll}, time::{Duration, Instant}};

pub struct TimerFuture {
    // Duration of our interaction
    // Simulates a data processing happening on the background
    duration: Duration,
    // Referential time used to resolve the Future
    start: Instant
}

impl TimerFuture {
    pub fn new(duration: Duration) -> Self {
        Self {
            duration,
            start: Instant::now()
        }
    }
}

impl Future for TimerFuture {
    // Output itself is not important here
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.start.elapsed() >= self.duration {
            return Poll::Ready(());
        }

        // The VTable ── it implements the methods to wake our Executor, with the wake() call again, this way executor executes this 'poll([...])' again.
        // This is made by pushing the taskId on the Executor's task-queue (can have a lot of different implementations)
        let waker = cx.waker().clone();
        let time_left = self.duration - self.start.elapsed();

        std::thread::spawn(move || {
            std::thread::sleep(time_left);
            // This tells the executor: "TimerFuture is ready to be polled again!" (Pass to the next stage of the State Machine)
            // It simulates the kernel signal our data is ready, it is likelly made on a Reactor, implemented using epoll() or kqueue() systems.
            waker.wake();
        });

        Poll::Pending
    }
}

// Handles the Executor for us (!!)
#[tokio::main]
async fn main() {
    println!("Waiting 2 seconds...");
    TimerFuture::new(Duration::from_secs(2)).await;
    println!("Done!!")
}
```

The code below presents a basic async interaction, it uses the _Tokio_ engine as the _**Executor**_, this way we can just focus on the interaction; And now that we have a basis lets scrutinize and see what really happens behind the scenes.

The first lines defines a _TimerFuture_ which is a simple struct with two fields:

- Duration: How long will be our interaction.
- Start: Referential time so we can resolve the Future.

Next we have the most interesting and important definition: the Future trait itself which has this signature:

```rust
impl Future for TimerFuture {🚂 // (my brother has put this train emoji on the article while I was writting, so I had no choice but keep it on so I can remember of this scene later, xD)
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {...}
}
```

The Future trait need some pieces in order to work:

- An _Executor_: The engine that advances it's state _(with some kind of Reactor)_.
- A _Waker_: The signal our data is ready. Passed throught a Context<'_> object.
- An Enum representing the actual state ── the _Poll_ Enum ── returned by ```Future::poll()```.

It might look confusing at a first glance, but the trait is pretty simple on reality; It takes two arguments and returns an **Enum**:

- Itself Pinned: Basically means the structure cannot be moved in memory.
- The Context: The bridge between the trait and the _Executor_, it existence rounds around the _Waker_ itself.
- The Poll Enum: Can be ```Ready(T)``` or ```Pending```.

Ok, but how Future is really used? How do I implement that? How do I connect the pieces together? That's what we are about to see next.

### The Machinery

Before diving into the concepts, I want to present a visual representation of the async execution.

![future-unresolved](future-unresolved.png)

Here we can see how all these pieces interacts roughly with each other and create a basic visual intuition of these interaction.
But what happens when the Reactor finally receives the _'ready'_ notification from OS? Here's more visual representation:

![future-resolved](future-resolved.png)

It is worth to take a bit of time and analyse the images calmly ──.
Now, lets analyse the Future trait concepts in more deepth.

### The Pin Trait

The **Pin** API is one of the most confusing concepts in Rust and I strongly agree that is because it is almost never used 'purely' on most of the projects, but is fundamental to be understood when deep diving into async Rust; It is just a tool that people generally doesn't need to deal with. The idea behind it is actually pretty simple: It is a smart pointer whose value underneath it is guaranted by the compiler to never be moved on memory if the underlying type doesn't implements the automatic ```Unpin<T>``` ── simple as that ── This implies some interesting behaviors:

- **Pin** is _transparent_: If the underlying type implements ```Unpin<T>```, like ```Unpin<Box<String>>``` you still can get safely an ```&mut T```, as String implements ```Unpin```, replacing it with ```mem::replace``` or ```mem::swap``` is possible.
- Can be used to pin Heap or Stack values.
- Pinned values are dropped normally on final of scopes.

> With '_purely_' I mean projects which is not included on the async in-hand Future usage scope.

```Pin``` pointer is _transparent_ and means specifically on the Future context (because it doesn't implement _Unpin_): _"Once you start polling this Future, it stays at this memory address forever."_ here is an example:

```rust
use std::pin::Pin;

fn main() {
    // Stack value
    let mut number: u8 = 10;

    // Pin !!
    // Since u8 is Unpin, we can use the safe 'Pin::new'
    let mut pinned_number: Pin<&mut u8> = Pin::new(&mut number);

    // Get a &mut ref back
    // 'get_mut()' is SAFE specifically because u8 is *Unpin*
    *pinned_number.get_mut() = 20;

    println!("Number is now: {}", number); // 20
}
```

Again, the values which can be moved safely on memory implements the ```Unpin<T>``` trait which most of Rust primitives automatically implements. That's why it's _transparent_ too, Unpinned types can still be drawn as &mut T.

### The Context<'_>

```rust
// [rust::std] internal repr

pub struct Context<'a> {
    waker: &'a Waker,
    local_waker: &'a LocalWaker,
    ext: AssertUnwindSafe<ExtData<'a>>,
    // Ensure we future-proof against variance changes by forcing
    // the lifetime to be invariant (argument-position lifetimes
    // are contravariant while return-position lifetimes are
    // covariant).
    _marker: PhantomData<fn(&'a ()) -> &'a ()>,
    // Ensure `Context` is `!Send` and `!Sync` in order to allow
    // for future `!Send` and / or `!Sync` fields.
    _marker2: PhantomData<*mut ()>,
}
```

While Futures doesn't do anything on their own until being polled, the **Context** is the intermediate object (_the bridge_) between the _**Executor**_ and the _**Future**_, simple and just as that.
Let's look at its fields:

#### Waker

The single most important field. Waker is the signal that means data is ready to be polled.

A _**Waker**_ is a manual vtable pointing to your executor's callback functions. Confusing and vague, isn't it? Let's explore it better.

Rust async model is _poll-based_ (pull) what means we don't create a callback like Nodejs and push it to the async runner (like Node's Event-Loop).

The _**Executor**_ calls ```poll(context)``` -> Context is created inside the Executor's handle function (could be a ```run()``` or whatever).
The _**Executor**_ _tries_ to advance _**Future**_ (executes our internal implementation ── our custom poll() trait implementation!) -> If _**Future**_ is blocked (we decide when internally; e.g, waiting for TCP packet) it returns ```Poll::Pending```.

An crucial implementation detail on ```Future::poll([..])``` is that before returning the ```Pending``` variant, it must register interest in being woken up when the resource is ready. It does this by cloning the ```Waker``` inside this ```Context```, and passing it to a _Reactor_ (e.g., epoll or kqueue; More on that later).

When data is ready and arrives, the _Reactor_ uses that _**Waker**_ (e.g, wake_as_ref([...] from ArcWaker trait from futures crate) to send a signal to _**Executor**_ which ```poll([..])``` the _**Future**_ again, without the _**Waker**_, the _**Future**_ would have no way to tell the runtime _"I am ready now."_

#### Local Waker

A single-thread optimization, it makes possible to wake tasks without the overhead of atomic synchronization ── as standard Waker must implement ```Send``` + ```Sync``` so it might be woken up from a different thread.

#### ext: Future-Proofing and Data

This field acts like a 'escape hatch'. It allow the runtime to pass auxiliary data throught the poll stack, without changing the function signature; The ```AssertUnwindSafe``` tells the compiler: "Trust me, if this code panics while unwinding the stack, this data won't leave the program in an undefined state."

It is often used for things like Distributed Tracing (passing a Span ID down the stack) or runtime-specific metrics. But is not that important to us on the matters of this article.

#### marker: The Type-Theory Hack

```rust
    PhantomData<fn(&'a ()) -> &'a ()>,
```

This PhantomData creates a variant guard. Its lifetimes enforces Invariance:

- Covariance (Standard): If you need a &'short T, passing a &'long T is usually fine. Rust automatically shrinks the lifetime.
- Invariance (Forced here): You must pass exactly 'a. Constrain the lifetime.

#### marker: The Thread-Safety Guard

This ensure ```Context``` !Send and !Sync.

As *mut () is a raw pointer and raw pointers are not thread-safe, including this makes the struct automatically opts out of the Send and Sync traits.

### Waker's Core

The Waker is a _'notify me button'_, and is generally created with a ```waker_ref(&task)``` call what internally creates a static VTable with some methods specifically for our task:

- clone(): How to increment the reference count (usually Arc::clone).
- wake(): What to do when the task is ready (usually "push this Arc back into the Executor's queue").
- wake_by_ref(): Same as wake(), but without consuming the Arc.
- drop(): How to decrement the reference count.

This VTable is a unsafe const struct created at compile time; The WakerRef is a representation of a mapping of our Task() methods (like wake_as_ref() from ArcWaker trait) ── _[use futures crate]_.
We could do this manually, but the _futures_ crate already implements the hard-work for us.

### Poll

Poll is a mechanism activated by the Executor which try to advance the state of a future.
It works like a crank on a mechanical engine. Every time the **Executor** turns the crank ```poll()```, the machine returns a state (which can still be pending as ```poll()``` doesn't mean to _resolve_ the Future) and can advance to the next "notch" (the next .await)

That's exactly how the compiler transforms the code and "unpause" the execution, using the structure from earlier:

```rust
// As shown earlier on the article

async fn my_logic() {
    let url = String::from("https://[...]"); // Local variable

    // Await Point #1
    let data = fetch_data(url).await;

    // Await Point #2
    parse_data(data).await;
}

enum MyLogicFuture {
    Unresumed,

    WaitingForData {
        url: String,
        child_future: FetchDataFuture,
    },

    WaitingForParse {
        child_future: ParseDataFuture,
    },

    Completed,
}
```

And it's ```poll()``` implementation:

```rust
impl Future for MyLogicFuture {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        // Thread-Block and state-loop mechanism
        loop {
            match *self {
                // #1: Start the function
                MyLogicFuture::Unresumed => {
                    let url = String::from("https://[...]"); // Our local var
                    let fut = fetch_data(url); // Start the async operation

                    // TRANSITION STATE: Save progress and move to next state
                    *self = MyLogicFuture::WaitingForData {
                        url,
                        child_future: fut
                    };
                    // Loop again to poll the new child future immediately
                }

                // #2: Check for data fetching
                MyLogicFuture::WaitingForData { ref mut child_future, .. } => {
                    // Ask the child: "Are you done yet?"
                    match child_future.poll(cx) {
                        Poll::Ready(data) => {
                            // Child is done! We have 'data'.
                            // Start the next step.
                            let parse_fut = parse_data(data);

                            // TRANSITION STATE
                            *self = MyLogicFuture::WaitingForParse {
                                child_future: parse_fut
                            };
                        }
                        Poll::Pending => return Poll::Pending, // Still waiting, yield control
                    }
                }

                // #3: Check for parse data availability
                MyLogicFuture::WaitingForParse { ref mut child_future } => {
                    match child_future.poll(cx) {
                        Poll::Ready(_) => {
                            // All done!
                            *self = MyLogicFuture::Completed;
                            return Poll::Ready(()); // Data could be returned here
                        }
                        Poll::Pending => return Poll::Pending,
                    }
                }

                MyLogicFuture::Completed => panic!("Polled a completed future!"),
            }
        }
    }
}
```

### The Reactor

A Reactor is the structure whose effectivelly interacts with ```epoll()``` or similar Kernel-bound events. It is effectivelly the bridge between the application and those events; It roughly works by associating a Waker to a file descriptor (which is like the _'door'_ our data will come in) and when notified by the Kernel the data is ready, it calls the ```wake()``` method on the Waker`, what puts the Waker back on the Executor's queue, ready to be ```poll()``` again.

The Reactor is implemented by crates like ```mio``` but can be implemented on a custom way too.

> Here I focused specifically on ```epoll()``` mechanism but there are some other methods in order to make that interaction work.

## The Art of Async Rust

Now, let's visualize what the 'Self-Referential Structs' looks like. You must have heard a lot of them while seeking to understand _Futures_ but may have never seem one; It is because Rust represents it beneath the hood for us. Let's inspect this basic async block:

```rust
async fn my_function() {
    let data = [0u8; 1024];
    let ref_to_data = &data; // A reference pointing to 'data'

    // The actual fn state must be saved here !!
    some_other_future().await;

    // We use the reference after the wait
    println!("{:?}", ref_to_data);
}
```

which rougly becomes this:

```rust
// This represents a single state inside the Enum State-Machine.
// This is roughly what the compiler generates for you
struct MyFunctionFuture {
    // The data variable
    data: [u8; 1024],

    // The reference variable (pointer)
    // It points to the 'data' field ABOVE, in this same struct!
    ref_to_data: *const [u8; 1024],

    // State tracking (are we waiting? finished?)
    state: State,
}
```

That's effectivelly what the Executor sees: Each async block became a Enum which each state (not the field 'state') counts on a _struct_ **representing it's state on a point-in-time**; It's state is saved on each await point. The field with a reference to the struct's own field is why ```Pin``` is needed.
It's also important to note that Rust only keeps on this struct post-required variables (like some variable used after ```some_other_future()```).

### Rust Matryoshka Futures

What happens when I nest async calls so? Rust keeps saving the state into it's internal fields, like a struct Future1 which holds it's child Future2 object. This way:

```rust
async fn child_task(data: String) {
    // 'data' is used here after some wait
    some_timer().await;
    println!("Processed: {}", data);
}

async fn parent_task() {
    let my_arg = String::from("Hello");
    // We pass 'my_arg' to the child
    child_task(my_arg).await;
}
```

will roughly generate:

```rust
struct ChildFuture {
    // The argument is saved right here as a field (!!)
    data: String,
    // The timer we are waiting on
    timer_future: TimerFuture,
    state: State,
}
```

and the Parent:

```rust
struct ParentFuture {
    // The Parent doesn't hold 'String' anymore.
    // It holds the whole CHILD, which holds the String.
    child_future: ChildFuture,
    state: State,
}
```

That's how Rust can keep _Futures_ on _**Stack**_, without Heap allocation, like a russian Matryoshka doll.

But how this struct is used by Executor at runtime?

As the _Executor_ gets some _Futures_ to run, it effectively uses the ```poll()``` function from the _Future_ trait; Each ```poll()``` cycle is determined by the _Reactor_ which dictates _**when**_ the ```poll()``` should be called; This way the executor doesn't need to _**wait**_ for the _Future_ resolution, it just receives the _Future_ on it's queue again by the _Waker_ interaction with the _Reactor_.

## The_Big_Picture(The_Big_Picture)

Finally, I want to show a kernel-hardware picture of the interaction between the _**Executor**_, _**Kernel**_ and **Hardware**. We are going to see a basic interaction reading data from a Socket.

```text
EXECUTOR             FUTURE               REACTOR              OS KERNEL
    |                    |                    |                    |
    |---- poll(cx) ----->|                    |                    |
    |                    |--- read() ----------------------------->|
    |                    |<-- EWOULDBLOCK -------------------------|
    |                    |                    |                    |
    |                    |-- register(waker)->|                    |
    |                    |                    |-- epoll_ctl(add) ->|
    |<-- Poll::Pending --|                    |                    |
    |                    |                    |                    |
(Goes to sleep           |                    |                    |
 or runs other           |                    |                    |
 tasks)                  |                    |                    |
    |                    |                    |<-- Data Arrives ---|
    |                    |                    |-- epoll_wait() --->|
    |                    |                    |<-- FD Ready -------|
    |                    |                    |                    |
    |<------------------------- wake() -------|                    |
    |                    |                    |                    |
    |---- poll(cx) ----->|                    |                    |
    |                    |--- read() ----------------------------->|
    |                    |<-- Bytes! ------------------------------|
    |<-- Poll::Ready ----|                    |                    |
```

### The Application Phase

Here is important to explain what is a Leaf Future. This special type of Future comes from the Leaf idea of a tree (the exact tree structure from nested async blocks). It is a conventional name, which denotes a Future whose is on the _Leaf_ of the async tree and interacts with the OS directly, like waiting for a Socket. A Future whose does not _awaits_ for any other future.
Leaf Futures are created and executed just like normal Futures, the difference is just that they interact directly with the OS.
Here is interesting this distiction for us because a picking a ordinary Future could mean we didn't needed to make any Kernel/Hardware interaction depending of the code, so here and now we are working with _Leaf Futures_. Lets continue:

Execution: Leaf Future tries to read a TcpStream, but the buffer is empty. Its Waker gets cloned from the context by the _**Executor**_ and stores it alongside the socket ID (file descriptor);
Reactor Registration: The leaf future (or the runtime) tells the OS: "Hey, wake me up when File Descriptor 12 has data."
Syscall: epoll_ctl (Linux), kqueue (macOS), or IOCP (Windows).

### The OS Phase

The Kernel holds the request in its network stack; When the packet arrives, it marks the data as 'Readable' for our specific Descriptor (12).
This phase is shortened here because it's implementation details can have many faces, so I focused on the part it makes intuitive and interesting to us right now.

### The End-of-Nap Phase

The Reactor loop has a ```wait()``` mechanism like a ```epoll_wait()``` method, which basically tracks events on file descriptors; When the Kernel marks the descriptor as 'Readable' it is notified to ```epoll()``` (which our Reactor interfaces with), signaling our data is ready.
It looks up to the Waker associated with this specific File Descriptor and calls the ```wake()``` method, what puts the Future associated with the Waker on the Executor's queue. This action to 'put the Future on the Executor's queue' is made by an implementation of a ArcWake trait; This trait can be implemented manually by us and specifies how the Future is put on the queue of the Executor. It's implementation can be like this:

```rust
pub struct Task {
    pub future: Mutex<Option<BoxFuture<'static, ()>>>,
    pub task_sender: SyncSender<Arc<Task>>
}

impl ArcWake for Task {
    fn wake_by_ref(arc_self: &Arc<Self>) {
        // When wake() is called, we send a clone of the Arc<Task>
        // back into the channel for the Executor to pick up.
        let cloned = arc_self.clone();
        arc_self.task_sender.send(cloned).expect("Queue closed");
    }
}
```

On the other end of the task_sender, is the Executor's queue, which is probably waiting with the recv() method.

### What was that all about?

Well, we are reaching the end of the article and I would like to enlight a hidden observation and the motivation of the entry phrase of this article. If you pay attention to the entire meaning of something being async, you will probably reach at this simple idea:
CPU is not the only piece of processing unit on the computer, it is only the _central_ one, that's where the phrase came from: The idea of async runtimes is to not have to _block_ while other pieces of hardware are working; Like on our socket read example, we was effectivelly waiting (even that ideally) for other piece of hardware to complete it's processing (the Network Interface Card in this case), while our CPU would be _free to execute other work_ (!!).

Hope you have enjoyed this interesting async walkthrough, don't forget to leave a comment. CYA (!!).
