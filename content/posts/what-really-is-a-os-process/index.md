---
title: "A Guide on How to Execute Linux Processes"
date: 2025-01-30
draft: false
tags: ["rust", "network", "linux", "low-level programming", "assembly"]
toc: true
---

> In case of an armageddon, we know how to make it work again.

On reality _Processes_ are a bundle of internal kernel structures, yes, actually _C structs_; Hopefully syncronized and connected orchestrated by a Scheduler.
Specially on Linux Kernel, we have the ```task_struct``` (defined specifically on ```include/linux/sched.h```); [Visualize it here](https://elixir.bootlin.com/linux/v6.17/source/include/linux/sched.h#L816).
When the kernel "schedules" a process, it is essentially loading data this struct points to into the CPU registers.

## The face of task_struct

The **task_struct** is like a save card for the Kernel, and the Kernel itself keep a copy of them for basically every single process. When we use, for example, _top_, _htop_ or even _ps_ command, we are asking the Kernel to read, format and send to us some fields of this struct.

Let's look at some of the fields ```task_struct``` has; Components stored in this structure include:

- Identifiers:
  - PID (Process ID): The unique number identifying the process.
  - PPID (Parent PID): The ID of the process that created this one.
  - TGID (Thread Group ID): If a process is multi-threaded, all threads share the same PID (in user space view) but have different kernel TIDs.
- State: Is the process running? Waiting for network data? Stopped? Actually, this state is a TASK_RUNNING, TASK_STOPPED etc... It helps the Kernel information to better manage the process.
- Scheduling Information: Priority, policy (e.g., _SCHED\_NORMAL_ vs _SCHED\_FIFO_), and time-slice usage.
- File Descriptor Table: A list of all open files, sockets, and pipes.
- Virtual Memory Map (_mm\_struct_): Pointers to exactly which parts of physical RAM this process owns.

No need to worry about what each one does, lets focus on what matters the most for this article: The Memory Layout (_```mm_struct```_) and how a _Process_ sees it.

Every process believes it has access to the entire memory range of the CPU _(e.g., 48 bits on modern x86_64)_. This is an illusion provided by virtual memory; The layout is standardized and you must have heard about some of them:

- Text Segment (Code): The actual binary machine code instructions. This is usually read-only to prevent the program from accidentally modifying its own logic.
- Data Segment: Global variables and static variables that are initialized.
- BSS (Block Started by Symbol): Uninitialized global variables (automatically set to zero by the _Kernel_).
- Heap: Dynamically allocated memory (where ```malloc``` or ```Box::new``` lives). It grows upward (towards higher addresses).
- Memory Mapping Segment: Where shared libraries (.so files) and file mappings (_mmap_) reside.
- Stack: Local variables, function parameters, and return addresses. It grows downward (towards lower addresses).
- Kernel Space: The very top of the memory addresses are reserved for the kernel. A process cannot read this directly; it must use syscalls.

Let's imagine we are at Bash and executes a binary, let's say ```./my_program```; When you execute that binary file from the exec family (like ```execve```, which generally happens always when we execute a binary)
the _Kernel_ performs a huge operation, destroying the current processes' existing memory mappings. The PID remains the same, but the _Kernel_ now reads the header of the new binary to figure out how to set up the new segments.

The binaries can even inspect itself at runtime:

```rust
use std::env;

// DATA SEGMENT: Initialized global variable
static GLOBAL_DATA: i32 = 100;

// BSS SEGMENT: Uninitialized global (zeroed by default)
// In Rust, statics must be initialized, but 0 often lands in BSS
static GLOBAL_BSS: i32 = 0;

fn main() {
    // TEXT SEGMENT: The address of the code itself
    let function_address = main as *const ();

    // HEAP: Dynamically allocated memory
    let heap_var = Box::new(42);

    // STACK: Local variable
    let stack_var = 50;

    // STACK (Top): Environment variables/Args live at the very top
    let args_address = env::args().next().unwrap();

    println!("=== MEMORY SEGMENTS (Low -> High) ===");

    println!("Text (Code)    : {:p} (Address of main function)", function_address);
    println!("Data (Global)  : {:p} (Static initialized)", &GLOBAL_DATA);
    println!("BSS (Global)   : {:p} (Static zeroed)", &GLOBAL_BSS);
    println!("Heap           : {:p} (Boxed value)", heap_var);
    println!("Stack (Local)  : {:p} (Local variable)", &stack_var);
    println!("Stack (Args)   : {:p} (Cmd line args)", &args_address);

    println!("\nCheck the process's map with:");
    println!("cat /proc/{}/maps", std::process::id());

    // Keep process alive so you can check /proc/
    // std::thread::sleep(std::time::Duration::from_secs(10));
}
```

And you should see something like this:

```txt
=== MEMORY SEGMENTS (Low -> High) ===
Text (Code)    : 0x55dcd2958080
Data (Global)  : 0x55dcd298a004
BSS (Global)   : 0x55dcd298a008
Heap           : 0x55dcd435ebb0
Stack (Local)  : 0x7ffd5a98d3cc
Stack (Args)   : 0x7ffd5a98e1a8
```

> The exact addresses may change as the memory is dynamically allocated _(!!)_

Now, let's inspect the behavior of ```task_struct```: What really happens to it when we realize this 'Brain Transplant'?

Think of ```task_struct``` as a 'backpack' of the process; During the ```execve()``` syscall the _Kernel_ doesn't free the ```task_struct```, instead, the _Kernel_ recycles the struct and just scrubs some of it's content; It proceeds basically this way:

- Identity Persists: The pid and tgid (Thread Group ID) remain the same. The process maintains its place in the process tree (parent/child pointers).
- Memory Swap: The pointer to struct mm_struct (which defines the memory map we discussed earlier) is dropped. A fresh mm_struct is created for the new binary.
- File Descriptors: Most open files (in struct files_struct) are kept open, unless you marked them with the FD_CLOEXEC flag (Close-on-Exec).
- Signals: Custom signal handlers are reset to default (because the custom handler code was in the old binary, which is now gone!).

Next, we are about to see how the _```task_struct```_ interacts with the CPU.

## The CPU Registers

When we write code or think about operating systems, we often think in terms of "processes," "threads," and "applications." We imagine these as distinct entities running on our computer, which is pretty valid. However, this is a high-level abstraction provided by the Operating System.
The CPU is, at its core, a surprisingly simple machine in terms of its perspective. It does not have a concept of "Firefox", "Rust", or even "Process ID 1234." _(WOW!)_

_The CPU only knows what to do right now based on what is in its hardware registers_.

Ok, but _**How that happen exactly**_?

Now is valid to take a break and visualize how the CPU executes these instructions.

The CPU only knows what to do right now based on what is in its hardware registers.
it just executes the instruction at the address in the Instruction Pointer (RIP/EIP) using data in general registers (RAX, RBX, etc.).

### The Instruction Pointer

This is arguably the most important register for control flow.

- **RIP (64-bit)** or **EIP (32-bit)** contains the memory address of the **next** instruction to be executed.
- The CPU's life cycle is an endless loop of:
  1. **Fetch:** Read the bytes at the memory address stored in RIP.
  2. **Decode:** Figure out what those bytes mean (e.g., "**ADD RAX**, **RBX**").
  3. **Execute:** Perform the action.
  4. **Update RIP:** Move the pointer to the next instruction.

### General Purpose Registers (RAX, RBX, RCX, etc.)

These are used to hold data while it is being worked on.

- **RAX (Accumulator):** Often used for arithmetic logic and return values.
- **RSP (Stack Pointer):** Points to the top of the current stack frame in memory

When a POP instruction happens (whether it's an assembly _**pop rax**_ or a high-level _**stack.pop()**_ that compiles down to it):

   1. Read: The CPU reads the data residing at the memory address currently stored in RSP.
   2. Adjust: The CPU increments (adds to) the RSP address (usually by 8 bytes on a 64-bit system).

Why add?
On x86 architecture, the stack grows downward (from high memory addresses to low memory addresses).

- PUSH: Subtracts from RSP (moves it "down" into free space) and writes.
- POP: Adds to RSP (moves it "up" back towards the start), effectively "freeing" that space.

And the kernel handles all of that for us for free, nice.

### Scheduling and Loading

When the kernel decides to run Process B instead of Process A (scheduling), it performs a **_Context Switch_** using the _CFS_ scheduler (more about it later):

- Save: It copies the current live CPU register values into Process A's ```task_struct``` (saving its spot).
- Load: It copies the stored register values from Process B's ```task_struct``` back into the actual CPU hardware registers.

And this is a heavy operation which involves saving Process A state, and run Process B, by taking it's value from ```task_struct``` and positioning it on the right CPU registers,
but what really means to _**position**_ this data?

### The MOV Instruction

When we say the kernel "positions" data into registers where effectivelly flipping electrical switches.
The CPU registers are physically located on the processor die. To "position" a value there, the CPU executes a specific instruction, usually called MOV (Move) or POP.

Imagine the kernel wants to restore Process B. Process B's saved state is stored in RAM at address 0x5000. The kernel executes an assembly instruction like this:

1 MOV RAX, [0x5000]  ; Read value at memory 0x5000, write it into register RAX

And physically:

1. The CPU sends a signal to the RAM controller: "Give me data at 0x5000."
2. RAM sends back a burst of electricity (the electrons) representing the bits.
3. These electrons flow into the RAX register circuits, flipping the transistors to match the saved value.
4. Result: The RAX register now holds the exact value Process B had when it stopped.

> _"Positioning" simply means overwriting the current electrical state of the register with a saved value._

### How to 'send' to the CPU?

We don't "send" instructions to the CPU like a network packet! Instead, we place them in its path.
As a dumb infinite loop machine the CPU acts like a needle on a vinyl record. It plays whatever is under the needle, then moves to the next groove.

- The Needle: The RIP (Instruction Pointer) register.
- The Vinyl: Your system's RAM.

The Mechanism works this way:

1. The CPU looks at RIP -- the next instrution pointer: "What memory address is listed here?" (for example, 0x0040).
2. It fetches the byte at 0x0040.
3. It executes it.
4. It automatically adds +1 (or instruction size) to RIP.
5. Repeat.

To "ask" the CPU to do something, you simply write the binary code for that action into RAM, and then force the RIP register to point to that RAM address.

---

### From Rust to CPU

For visualization sake let's use the Rust compiler (rustc): It checks types and borrow rules, then translates it to LLVM IR. This is a generic assembly-like language (e.g., %3 = add nsw i32 %1, %2).
When you run cargo build --release, a complex translation chain occurs to turn human logic into "switches". Let's see an example:

Rust Source Code (High Level)
You write:

```rust
   fn main() {
       let x = 10;
       let y = 20;
       let z = x + y;
   }
```

This code gets translated by LLVM to the IR into the specific Assembly language for your CPU (x86_64 or ARM).
mov eax, 10      ; Put 10 into accumulator (EAX/RAX)
add eax, 20      ; Add 20 to whatever is in EAX

The Assembler (do not confuse with Assembly) translates those words into specific OpCodes (Operation Codes). These are the hex numbers the CPU hardware is hardwired to understand.

- mov eax, ... might become the byte 0xB8.
- add ... might become 0x83.

Final Executable File (on disk):
It is just a long string of bytes: B8 0A 00 00 00 83 C0 14 ...

  ---

### How execution actually starts

You now have a file on your hard drive. A bunch of bytes. To execute it, the OS performs a "Loader" operation:

1. Read: The OS reads the binary file from the disk.
2. Allocate: It asks the kernel for a chunk of empty RAM.
3. Copy: It copies those bytes (B8 0A ...) into that RAM (e.g., starting at address 0x9000).
4. The "Jump" (The Spark):
    The OS creates a task_struct, sets the RIP value in that struct to 0x9000 (the start of your code), and tells the scheduler: "This process is ready."

The moment the **Scheduler** picks your process:

1. It loads 0x9000 into the physical RIP register.
2. The CPU hardware clock ticks.
3. The CPU looks at RIP (0x9000).
4. It sees 0xB8 (the MOV opcode).
5. It executes it.

Your Rust program is now alive.

So:

- Positioning: Copying bits from RAM to Registers using electrical signals.
- Sending Instructions: Placing bytes in RAM and pointing the RIP register at them.
- Compilation: Translating human text -> Assembly Mnemonics -> Binary Opcodes.
- Execution: Loading that binary into RAM and forcing the CPU's "eye" (RIP) to look at it.

## The Scheduler

The Linux OS scheduler is called CFS (Completely-Fair Scheduler), it is algorithm managed by the _Kernel_ (located at ```kernel/sched/fair.c```) which tracks a single, critical variable inside _task_struct_, a substruct called _**sched_entity**_, which has our target field: The _**vruntime**_.
The CFS always wants to run the task with the smallest _vruntime_. For this, it uses a mathematical schema with the **Red-Black Tree** data structure the Scheduler uses to distribute computation time between the processes.

{{< figure src="vruntime-formula.png" alt="alpine folder" class="center" >}}

* High Priority (Low Nice): Their **vruntime** grows slowly. They stay on the "left" side of the tree longer and get more CPU time.
* Low Priority (High Nice): Their **vruntime** grows very fast. They zoom to the right side of the tree quickly, giving up the CPU to others.

Every process has a Nice value, which dictates the importance relation between the processes.

If you have two processes running:

* Process A (Nice 0): Its weight is 1024. Its vruntime increases by exactly the amount of time it spent on the CPU.
* Process B (Nice 5): Its weight is much lower (approx 335). Its vruntime increases much faster than the actual clock time.

## Final Words

The main purpose of the article is to give a intuition of what is happening beneath the hood (even that _basically_) on a matter all of we work daily on but most of the time we don't have a minimal idea of what's going on, and if we don't know that, we automatically don't know what can be made with it or what it can do; These are the things we _don't know we don't know_ (but now you do!).

The article sake is to to go deeply but not too deep into the matter, or this article would have easily > 1024 topics. CYA(!!).
