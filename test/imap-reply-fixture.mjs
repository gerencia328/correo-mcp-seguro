export function fakeReplyImap(rawHeaders, failAppend = false) {
  const state = { commands: [], archived: "", expected: 0, closed: false };
  return { state, dial() {
    let ctrl, literalTag, remain = 0;
    const send = s => ctrl.enqueue(new TextEncoder().encode(s));
    return { opened: Promise.resolve({}), closed: Promise.resolve(),
      readable: new ReadableStream({ start(c) { ctrl = c; send("* OK synthetic\r\n"); } }),
      writable: new WritableStream({ write(bytes) {
        const line = new TextDecoder().decode(bytes);
        if (literalTag) {
          if (remain > 0) { state.archived += line; remain -= bytes.length; }
          else { send(`${literalTag} ${failAppend ? "NO rejected" : "OK stored"}\r\n`); literalTag = undefined; }
          return;
        }
        state.commands.push(line);
        const [tag] = line.split(" ");
        if (line.includes(" CAPABILITY")) send(`* CAPABILITY IMAP4rev1\r\n${tag} OK caps\r\n`);
        else if (line.includes(" EXAMINE")) send(`* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT 2] next\r\n${tag} OK read-only\r\n`);
        else if (line.includes(" UID FETCH")) send(`* 1 FETCH (UID 1 BODY[HEADER.FIELDS (FROM REPLY-TO TO CC SUBJECT DATE MESSAGE-ID REFERENCES)]<0> {${new TextEncoder().encode(rawHeaders).length}}\r\n${rawHeaders})\r\n${tag} OK fetched\r\n`);
        else if (line.includes(" APPEND")) { state.expected = Number(line.match(/\{(\d+)\}/)[1]); remain = state.expected; literalTag = tag; send("+ Ready for literal\r\n"); }
        else send(`${tag} OK done\r\n`);
      } }),
      async close() { state.closed = true; try { ctrl.close(); } catch {} },
      startTls() { throw Error("TLS already on"); },
    };
  } };
}
