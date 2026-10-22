// Synthetic transport; absolutely no network access or real addresses/credentials.
export function fakeSmtp(options = {}) {
  const state = { commands: [], submitted: 0, closed: 0, dials: 0 };
  return { state, dial(address, transport) {
    state.dials++;
    if (address.port !== 465 || transport.secureTransport !== "on") throw Error("TLS must be mandatory");
    let controller, ended = false, data = false, login = 0;
    const send = text => {
      for (const b of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(b));
    };
    const readable = new ReadableStream({ start(c) { controller = c; if (!options.hang) send(options.badGreeting ? "500 SECRET denied\r\n" : "220 synthetic ready\r\n"); } });
    return { readable, opened: options.tlsFailure ? Promise.reject(new Error("SECRET certificate failed")) : Promise.resolve({}), closed: Promise.resolve(),
      writable: new WritableStream({ async write(bytes) {
        const line = new TextDecoder().decode(bytes); state.commands.push(line);
        if (options.hangWrite) return new Promise(() => {});
        if (data) {
          state.submitted++;
          if (options.onSubmit) await options.onSubmit();
          if (options.ambiguous) { ended = true; controller.close(); }
          else send(options.rejectData ? "550 SECRET rejected\r\n" : "250 queued\r\n");
          data = false; return;
        }
        if (line.startsWith("EHLO")) send(options.malformed ? "250-start\r\n220 wrong code\r\n" : `250-synthetic\r\n250-AUTH ${options.loginOnly ? "LOGIN" : "PLAIN LOGIN"}\r\n250 SIZE 100000\r\n`);
        else if (line.startsWith("AUTH PLAIN")) send(options.badAuth ? "535 SECRET auth rejected\r\n" : "235 authenticated\r\n");
        else if (line.startsWith("AUTH LOGIN")) { login = 1; send("334 username\r\n"); }
        else if (login === 1) { login = 2; send("334 password\r\n"); }
        else if (login === 2) { login = 0; send(options.badAuth ? "535 denied\r\n" : "235 authenticated\r\n"); }
        else if (line.startsWith("MAIL FROM")) send("250 sender\r\n");
        else if (line.startsWith("RCPT TO")) send(options.rejectRecipient ? "550 recipient denied\r\n" : "250 recipient\r\n");
        else if (line === "DATA\r\n") { data = true; send("354 data\r\n"); }
        else if (line === "QUIT\r\n") send("221 bye\r\n");
        else send("250 ok\r\n");
      } }),
      async close() { state.closed++; if (!ended) { ended = true; controller.close(); } },
      startTls() { throw Error("Implicit TLS already active"); },
    };
  } };
}
