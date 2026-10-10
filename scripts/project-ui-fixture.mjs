// Explicit isolated MACHINE UI recipe; no witness directories or fixed port.
import {createProjectCorpus} from '../test/support/project-corpus.mjs';
import {createServer} from '../src/server.mjs';
const fixture=createProjectCorpus();
const result=await createServer({cwd:fixture.cwd,port:0});
console.log(JSON.stringify({classification:'MACHINE',url:result.url,fixture:fixture.cwd,documents:fixture.documents,human:'NOT_RUN'}));
