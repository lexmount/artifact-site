// The script injected into the "visual edit" preview page (see the /edit-frame route). It runs
// inside a sandbox iframe -- opaque origin, no allow-same-origin -- so it can never touch the parent
// page and speaks only over a **private MessagePort**.
//
// Its job is narrow: double-click a piece of text -> a caret appears in place -> change the words.
// It **no longer serializes the DOM**: on save it only sends back a patch of "which text node, what
// it was, what it became", and the parent page does the replacement on the **original source
// string** (see lib/text-writeback). That change is the precondition for the whole "pure editing
// experience": precisely because we no longer assume "post-run DOM == source", pages with <script>
// and folder sites can enter visual editing for the first time.
//
// The locating marks are stamped by the server before injection (data-ah-node / data-ah-texts,
// derived from parsing the source). The runtime only performs a few self-checks; if any fails, it
// refuses to edit and **states honestly which kind** (the parent page picks its copy from that)
// rather than guessing:
//   1. This element is not the **first-seen element** for its mark (see below), and the first-seen
//      one is still on the page -> copy;
//   2. Same, but the first-seen one is no longer in the document (a script replaced the original)
//      -> replaced;
//   3. The element's current child text node count does not match the source (a script inserted
//      nodes) -> structure;
//   4. No mark found -> unmarked.
// These self-checks run fresh **every** time a mark is used, not once at boot -- carousels and the
// like clone slides only at runtime, and checking once would let the user edit words on a copy and
// then write them to a different element in the source.
//
// [Why the criterion is "first-seen wins" rather than "only one element per mark"]
// The old criterion was `querySelectorAll('[data-ah-node=N]').length === 1`; the moment a copy was
// found the whole mark was condemned. On real artifacts that meant **not a single word on the page
// could be edited**: a slideshow-style artifact's runtime.js does `cloneNode(true)` on every slide
// to preview them in the thumbnail panel, so every piece of text exists twice in the DOM; that
// clone container also has pointerEvents:none, so the user cannot even click the copy -- they
// double-clicked the original in the main content, and we blocked them because a non-interactive
// copy existed elsewhere. The criterion was too coarse; the artifact was not at fault.
// Now: the original from the source necessarily enters the document **before** any script clone
// (this script is the first to execute in the document; artifact scripts can only clone what
// already exists), so "the element where a given mark first appears in the document" is the
// authoritative one. Copies are always refused (no automatic jump to the original -- predictability
// first); the original stays editable even with ten copies on the page.
//
// [Why MessagePort, not window.postMessage + nonce]
// With has_script removed, the artifact's own JS and this bootstrap share a document and a realm.
// If the parent page relied only on `e.source === iframe.contentWindow` plus a nonce to tell
// messages apart, **neither** distinguishes the two: the nonce sits in plain sight in this script's
// textContent (one `document.querySelector('script[data-ah-editor]')` read away), and e.source is
// the same window for both. Worse, winning the race is deterministic -- the parent attaches pending
// synchronously before postMessage, so an artifact script emitting forged patches with
// `setInterval(...,0)` is guaranteed to be resolved first, and the bootstrap's genuine reply, arriving
// later, is simply dropped; the forged patch even passes validation (el/i read from the DOM, before
// taken from the page's original text). The consequence: a victim editing their own fork gets the
// body text silently rewritten, and the audit records it as the victim's own method=visual edit.
// Now: the parent creates a MessageChannel and transfers port2 along with the ping; this script
// attaches its message listener during its **synchronous execution phase** (injected right after
// <head>, ahead of artifact scripts in the body), and on receiving the port immediately calls
// stopImmediatePropagation -- artifact scripts never even see the event, so they cannot get the
// port, so they cannot forge.
//
// This defence presupposes "this script is the first to execute in the document". HTML5 allows a
// `<script>` **before** `<html>`/`<head>` (the browser runs it first as implicit head content); such
// a script would register its message listener first, receive the handshake ping first, read the
// port, then stopImmediatePropagation, and impersonate the bootstrap in turn. So the premise is not
// left to prayer: /edit-frame checks with scriptPrecedesHead before injecting; on a hit it returns
// 409 (code: script_before_head) and sends not one byte of script, and the frontend immediately
// falls back to source editing.
//
// NONCE is still carried, to pair a reply with the editing session that initiated it; it is not a
// secret -- security rests on the port.

export const EDITOR_MARK = "data-ah-editor"; // marks the injected <script> for identification/tests

/** The script body, with `__NONCE__` pending substitution. */
const BOOTSTRAP = `(function(){
  "use strict";
  var NONCE=__NONCE__;
  var NODE="data-ah-node", TEXTS="data-ah-texts", WRAP="data-ah-wrap";
  var patches={};   // "el:i" -> {el,i,before,text}
  var active=null;  // the spot currently being edited {span,el,i,mark,owner,before}
  // Preview mode: hand the page back to the artifact (no key interception, double-click does not enter edit mode). Edited-but-unsaved text stays as is.
  var previewing=false;
  var booted=false;
  var port=null;    // private channel to the parent page; not a word goes out before the handshake succeeds
  var first={};     // mark -> first-seen element (append-only, see "first-seen wins" in the file header)
  var stats=null;   // editable/uneditable counts for this page, handed to the parent for its persistent notice

  // -- Primitive snapshots --
  // This script is the first <script> in the document (guaranteed by /edit-frame's
  // scriptPrecedesHead pre-check, see the file header) and executes before any artifact script; but
  // the parent page only hands over the port after the iframe has loaded. That window is long enough
  // for an artifact script to rewrite MessageEvent.prototype.ports / Event.prototype.isTrusted /
  // window.parent and forge a "ping from the parent" to trick us into talking to its port. So these
  // entry points are grabbed right now, and only the snapshots are trusted afterwards.
  var PARENT=parent;
  function grabGet(o,k){ try{ var d=Object.getOwnPropertyDescriptor(o,k); return (d&&d.get)||null; }catch(e){ return null; } }
  function grabFn(o,k){ try{ return (o&&typeof o[k]==="function")?o[k]:null; }catch(e){ return null; } }
  var ME=(typeof MessageEvent==="function")?MessageEvent.prototype:null;
  var G_PORTS=grabGet(ME,"ports"), G_SOURCE=grabGet(ME,"source");
  var G_TRUST=grabGet((typeof Event==="function")?Event.prototype:null,"isTrusted");
  var MP=(typeof MessagePort==="function")?MessagePort.prototype:null;
  var P_POST=grabFn(MP,"postMessage"), P_START=grabFn(MP,"start"), P_ON=grabFn(MP,"addEventListener"), P_CLOSE=grabFn(MP,"close");
  // First-seen registration relies on MutationObserver, which likewise must be grabbed before an
  // artifact script can rewrite window.MutationObserver / its prototype methods -- otherwise "which
  // one is the original" would be decided by the artifact script, the very party we are guarding against.
  var MO=(typeof MutationObserver==="function")?MutationObserver:null;
  var MO_P=MO?MO.prototype:null;
  var MO_OBSERVE=grabFn(MO_P,"observe"), MO_TAKE=grabFn(MO_P,"takeRecords");
  var HAS_OWN=Object.prototype.hasOwnProperty;
  // If a snapshot is unavailable (or the object is not a real event), fall back to reading the property directly -- fake events in tests take this path, browsers take the snapshot.
  function readOf(g,e,k){ if(g){ try{ return g.call(e); }catch(err){} } return e[k]; }
  function has(o,k){ try{ return HAS_OWN.call(o,k); }catch(e){ return false; } }

  function post(m){ if(!port) return; m.nonce=NONCE; if(P_POST) P_POST.call(port,m); else port.postMessage(m); }
  function count(){ var n=0,k; for(k in patches){ if(has(patches,k)) n++; } return n; }
  function notify(extra){ post({type:"ah-editor:dirty",count:count()+(extra||0)}); }
  function postStats(){
    if(!port||!booted||!stats) return;
    post({type:"ah-editor:stats",editable:stats.editable,script:stats.script,structure:stats.structure,copied:stats.copied});
  }
  function announce(){ if(port&&booted){ post({type:"ah-editor:ready"}); postStats(); } }
  function reject(reason){ post({type:"ah-editor:unmappable",reason:reason}); }

  // Visual cues for edit mode. Since saving goes through text writeback and never serializes the DOM, adding styles to the page is now entirely safe.
  function paint(){
    var s=document.createElement("style");
    s.setAttribute("data-ah-editor-style","");
    s.textContent="["+NODE+"]{cursor:text}"
      +"["+NODE+"]:hover{outline:1px dashed rgba(22,160,106,.6);outline-offset:2px}"
      +"["+WRAP+"]{outline:2px solid #16a06a;outline-offset:2px;background:rgba(22,160,106,.10)}"
      +"["+WRAP+"]:focus{outline-color:#0d7f52}";
    (document.head||document.documentElement).appendChild(s);
  }

  function textKids(el){ var r=[],c; for(c=el.firstChild;c;c=c.nextSibling){ if(c.nodeType===3) r.push(c); } return r; }

  // Canonical form of a mark. The registry and locate must obtain it through the same function, or "original" and "copy" would land on two different keys.
  // Both attributes must be present: markEditableText always writes them as a pair; an element with only data-ah-node can only have been forged elsewhere.
  function markOf(el){
    var v,n;
    try{
      if(!el||el.nodeType!==1||!el.hasAttribute||!el.hasAttribute(NODE)||!el.hasAttribute(TEXTS)) return null;
      v=el.getAttribute(NODE);
    }catch(e){ return null; }
    n=parseInt(v,10);
    return isNaN(n)?null:String(n);
  }

  function noteOne(el){
    var mark=markOf(el);
    if(mark!==null&&!has(first,mark)) first[mark]=el; // record only the first sighting
  }
  // Pre-order traversal (explicit stack, no recursion -- artifacts can nest very deeply).
  function noteTree(root){
    if(!root||root.nodeType!==1) return;
    var stack=[root],node,kids,c,i;
    while(stack.length){
      node=stack.pop();
      noteOne(node);
      kids=[];
      for(c=node.firstChild;c;c=c.nextSibling){ if(c.nodeType===1) kids.push(c); }
      for(i=kids.length-1;i>=0;i--) stack.push(kids[i]); // push in reverse so pops come out in document order
    }
  }
  function absorb(records){
    var i,j,added;
    if(!records) return;
    for(i=0;i<records.length;i++){
      added=records[i]&&records[i].addedNodes;
      if(!added) continue;
      for(j=0;j<added.length;j++) noteTree(added[j]);
    }
  }
  // Observe childList+subtree on documentElement. Installed at **evaluation time** (this script is
  // injected after <head>, before the body is parsed), so every element from the source is first seen through here.
  var obs=null;
  if(MO){
    try{
      obs=new MO(absorb);
      var target=document.documentElement||document.body;
      if(target){ if(MO_OBSERVE) MO_OBSERVE.call(obs,target,{childList:true,subtree:true}); else obs.observe(target,{childList:true,subtree:true}); }
      else obs=null;
    }catch(e){ obs=null; }
  }
  noteTree(document.documentElement); // whatever already exists (normally just half a head); defensive

  // The MutationObserver callback is a microtask; the user's double-click may well be queued ahead
  // of it. Consume the pending records before any query, so "who was seen first" is synchronously accurate at every moment.
  function drain(){
    if(!obs) return;
    try{ absorb(MO_TAKE?MO_TAKE.call(obs):obs.takeRecords()); }catch(e){}
  }
  function connected(node){
    var root=null,cur=node;
    try{ root=document.documentElement; }catch(e){ return false; }
    while(cur){ if(cur===root) return true; cur=cur.parentNode; }
    return false;
  }
  function firstOf(mark){
    drain();
    if(has(first,mark)) return first[mark];
    // Fallback: no MutationObserver (very old browsers), or documentElement was replaced wholesale
    // and the observer died with it. Fall back to "first in document order" -- the original from the
    // source precedes script-appended copies, so it is usually still the same one; once decided it is
    // remembered, and never changes its mind mid-edit. Even a wrong pick cannot corrupt anything: before
    // writing back, the parent still compares before with the source text (applyTextPatches) and skips the whole patch on mismatch.
    var list=null,i,el;
    try{ list=document.querySelectorAll("["+NODE+"=\\""+mark+"\\"]"); }catch(e){ list=null; }
    if(list){ for(i=0;i<list.length;i++){ el=list[i]; if(markOf(el)===mark){ first[mark]=el; return el; } } }
    return null;
  }

  // Map a DOM text node back to its position in the source. When it cannot be mapped, return {bad:<reason>}; never guess.
  function locate(node){
    var p=node.parentElement;
    var mark=markOf(p);
    if(mark===null) return {bad:"unmarked"};
    // Check first-seen before structure: when the user hit a copy, "this is a copy, edit the original" is far more useful than "structure mismatch".
    var owner=firstOf(mark);
    if(owner!==p) return {bad:(owner&&connected(owner))?"copy":"replaced"};
    var kids=textKids(p);
    if(String(kids.length)!==p.getAttribute(TEXTS)) return {bad:"structure"}; // a script altered the structure here
    var i=-1,j;
    for(j=0;j<kids.length;j++){ if(kids[j]===node){ i=j; break; } }
    if(i<0) return {bad:"structure"};
    return {el:parseInt(mark,10),i:i,mark:mark,owner:p};
  }

  // Text in these subtrees does not take part in visual editing and must not be counted as
  // "uneditable" either -- otherwise every <script>/<style> would count as a piece of text and the
  // number would be too large for anyone to believe. This list matches RAW_TEXT/OPAQUE in lib/text-writeback.
  var SKIP_TREE={SCRIPT:1,STYLE:1,TEXTAREA:1,TITLE:1,HEAD:1,SVG:1,MATH:1,CANVAS:1,IFRAME:1,OBJECT:1,TEMPLATE:1,NOSCRIPT:1,SELECT:1};
  // Direct text in the table skeleton is moved before the <table> by browser foster parenting; the scanner never marks it at all.
  var SKIP_TEXT={TABLE:1,THEAD:1,TBODY:1,TFOOT:1,TR:1};
  function tagOf(el){ try{ return String(el.tagName||"").toUpperCase(); }catch(e){ return ""; } }

  // "Are this element's children all inside a copy?" The root produced by cloneNode often has no
  // mark **itself** (the artifact clones a whole-screen <section>; the marks sit on the h1/p inside),
  // so looking only at "is there a copy among the ancestors" cannot detect it; looking one level down
  // is enough: if a copy appears among the direct children, this element is itself part of that copy.
  // Errors go in the direction of "count slightly fewer uneditable pieces" (skipping genuine script text as a copy), never inflating the number.
  function hasCopyChild(node){
    var c,m;
    for(c=node.firstChild;c;c=c.nextSibling){
      if(c.nodeType!==1) continue;
      m=markOf(c);
      if(m!==null&&firstOf(m)!==c) return true;
    }
    return false;
  }

  /**
   * How many pieces of text on this page can really be edited, and why each of the rest cannot. The
   * parent page uses it for a persistent one-line notice on the toolbar -- in the user's own words,
   * "I'm already in and still can't edit, popping that hint is weird", so this cannot wait until a double-click.
   *
   * Only **non-whitespace** text pieces are counted. Text inside copies is never counted again: its
   * source positions are already credited to the original, and counting twice would inflate
   * "N more pieces cannot be edited" into a scary fake number.
   */
  function measure(){
    drain();
    var editable=0,script=0,structure=0,copied=0;
    var lost={};
    var root=document.documentElement;
    if(!root){ stats={editable:0,script:0,structure:0,copied:0}; postStats(); return; }
    var stack=[{n:root,copy:false}],cur,node,inCopy,childCopy,tag,mark,owner,kids,intact,i,c;
    while(stack.length){
      cur=stack.pop();
      node=cur.n; inCopy=cur.copy; childCopy=inCopy;
      tag=tagOf(node);
      if(has(SKIP_TREE,tag)) continue;
      mark=markOf(node);
      if(mark===null){
        // No mark = the scanner did not cover it, which in practice means script-generated text at runtime. Inside copies it does not count.
        if(!inCopy&&!has(SKIP_TEXT,tag)){
          kids=textKids(node);
          for(i=0;i<kids.length;i++){ if(/\\S/.test(kids[i].nodeValue)) script++; }
        }
      } else {
        owner=firstOf(mark);
        if(owner===node){
          kids=textKids(node);
          intact=(String(kids.length)===node.getAttribute(TEXTS));
          for(i=0;i<kids.length;i++){
            if(!/\\S/.test(kids[i].nodeValue)) continue;
            if(intact) editable++; else structure++;
          }
        } else {
          childCopy=true; // this one is a copy
          // The original is gone from the document and only copies remain: nobody can safely edit this source position today, so report it.
          if(!(owner&&connected(owner))&&!has(lost,mark)){
            lost[mark]=1;
            kids=textKids(node);
            for(i=0;i<kids.length;i++){ if(/\\S/.test(kids[i].nodeValue)) copied++; }
          }
        }
      }
      if(!childCopy&&hasCopyChild(node)) childCopy=true; // the clone root often has no mark itself; look one level down
      for(c=node.firstChild;c;c=c.nextSibling){ if(c.nodeType===1) stack.push({n:c,copy:childCopy}); }
    }
    stats={editable:editable,script:script,structure:structure,copied:copied};
    postStats();
  }

  function pointText(e){
    var pos=null,r;
    if(document.caretPositionFromPoint){ pos=document.caretPositionFromPoint(e.clientX,e.clientY); }
    if(pos&&pos.offsetNode&&pos.offsetNode.nodeType===3) return pos.offsetNode;
    if(document.caretRangeFromPoint){ r=document.caretRangeFromPoint(e.clientX,e.clientY); if(r&&r.startContainer&&r.startContainer.nodeType===3) return r.startContainer; }
    var t=e.target,c;
    if(t&&t.nodeType===1){ for(c=t.firstChild;c;c=c.nextSibling){ if(c.nodeType===3&&/\\S/.test(c.nodeValue)) return c; } }
    return null;
  }

  // Settle the current edit: swap the temporary wrapper span back for a plain text node, restoring the parent's structure exactly.
  function commit(revert){
    if(!active) return;
    var a=active; active=null;
    var edited=a.span.textContent||"";
    var key=a.el+":"+a.i;
    var orig=has(patches,key)?patches[key].before:a.before; // on a second edit, before must still be the original text from the source
    // The last gate of "never write to the wrong place": confirm once more before committing that the
    // element I am editing **is still** the first-seen element for this mark. A script cloning a screen
    // mid-typing (carousels/thumbnails do exactly that) no longer trips it -- a copy can never displace
    // the original, and that edit should land as usual. The only way it can truly fail is "the first-seen
    // registry itself got corrupted", in which case we would rather revert on the spot and say so than write to another place in the source.
    var bad=!revert&&edited!==orig&&firstOf(a.mark)!==a.owner;
    var text=(revert||bad)?a.before:edited;
    if(a.span.parentNode) a.span.parentNode.replaceChild(document.createTextNode(text),a.span);
    if(bad){ reject("copy"); notify(0); return; }
    if(text===orig){ delete patches[key]; } else { patches[key]={el:a.el,i:a.i,before:orig,text:text}; }
    notify(0);
  }

  function begin(node,loc,so,eo){
    var span=document.createElement("span");
    span.setAttribute(WRAP,"");
    node.parentNode.replaceChild(span,node);
    span.appendChild(node);
    try{ span.contentEditable="plaintext-only"; }catch(err){ span.contentEditable="true"; }
    active={span:span,el:loc.el,i:loc.i,mark:loc.mark,owner:loc.owner,before:node.nodeValue};
    span.focus();
    try{
      var L=node.nodeValue.length,r=document.createRange();
      r.setStart(node,Math.min(so,L)); r.setEnd(node,Math.min(eo,L));
      var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }catch(err){}
  }

  document.addEventListener("dblclick",function(e){
    if(previewing) return;                            // preview mode: double-click belongs to the artifact (it may have its own dblclick behaviour)
    if(active&&active.span.contains(e.target)) return; // already editing this spot
    var sel=window.getSelection();
    var node=(sel&&sel.anchorNode&&sel.anchorNode.nodeType===3)?sel.anchorNode:null;
    var so=0,eo=-1;
    if(node&&sel.focusNode===node){ so=Math.min(sel.anchorOffset,sel.focusOffset); eo=Math.max(sel.anchorOffset,sel.focusOffset); }
    if(!node) node=pointText(e);
    if(!node||!node.nodeValue||!/\\S/.test(node.nodeValue)) return;
    if(eo<0){ so=0; eo=node.nodeValue.length; }
    commit(false); // restore the previous spot first, or the parent's text child count will not match
    var loc=locate(node);
    if(loc.bad){ reject(loc.bad); return; }
    e.preventDefault();
    // Once in edit mode, do not let the artifact use this double-click for something else too (some artifacts treat dblclick as zoom/page-turn).
    if(e.stopImmediatePropagation) e.stopImmediatePropagation();
    begin(node,loc,so,eo);
  });

  document.addEventListener("input",function(){ if(active) notify(1); });

  // [While text is being edited, the artifact's own interactions must yield]
  //
  // Real failure: a slideshow artifact attached global shortcuts on document without checking the event target --
  //   case 'ArrowRight': case ' ': case 'PageDown': case 'Enter': go(idx+1)
  //   case 'ArrowLeft':  case 'PageUp': case 'Backspace': go(idx-1)
  //   case 'f'/'s'/'n'/'o'/'t'/'a': fullscreen / presenter window / notes / thumbnail overview / switch theme / switch animation
  // So the user types a space in the editor and the artifact flips to the next slide (and
  // preventDefaults the space away), backspace flips back a slide, typing an o tiles the thumbnails
  // -- it looks like "after adding text the next slide shoved its way in and overlapped".
  //
  // preventDefault alone cannot stop it: that only cancels the default action; the event still
  // reaches the artifact's listeners. Propagation **must be cut**. And stopPropagation does not affect
  // default actions, so normal typing (inserting text, backspace deleting, arrow keys moving the
  // caret) keeps working -- the only thing blocked is "the artifact using this key for something else".
  //
  // Attached in document's capture phase, and the bootstrap is the first script in the document, so it gets the event before any artifact listener.
  function pageQuiet(e){
    if(e.stopPropagation) e.stopPropagation();
    if(e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  document.addEventListener("keydown",function(e){
    if(!active) return;
    if(e.key==="Enter"){ e.preventDefault(); commit(false); }
    else if(e.key==="Escape"){ e.preventDefault(); commit(true); }
    pageQuiet(e); // the remaining keys go to the browser's native editing behaviour, but the artifact receives none of them
  },true);
  // Cut keypress/keyup as well: some artifacts hang their shortcuts on those two.
  document.addEventListener("keypress",function(e){ if(active) pageQuiet(e); },true);
  document.addEventListener("keyup",function(e){ if(active) pageQuiet(e); },true);

  // Same for pointers: an accidental click on the artifact's own button/hot zone (page-turn, theme
  // switch, open overview) while editing scrambles the page state, while the user thinks they merely
  // clicked elsewhere. None of these events reach the artifact in edit mode; dblclick is not among
  // them -- it is our entry point for switching the edit target, and the dblclick handler above cuts propagation itself.
  ["click","mousedown","mouseup","pointerdown","pointerup","contextmenu"].forEach(function(t){
    document.addEventListener(t,function(e){ if(active) pageQuiet(e); },true);
  });

  document.addEventListener("focusout",function(e){
    if(active&&(e.target===active.span||active.span.contains(e.target))) commit(false);
  });

  // Fallback for when execCommand does not work: manually replace the selection with plain text.
  // **Does not enter the native undo stack** (see the trade-off at paste below), so it is used only when unavoidable.
  function insertPlainText(t){
    if(!active) return;
    var sel=(typeof window.getSelection==="function")?window.getSelection():null;
    if(!sel||!sel.rangeCount){
      // Cannot even read the selection: at least append the text to the piece being edited rather than silently swallowing the user's paste.
      active.span.textContent=(active.span.textContent||"")+t;
    } else {
      var r=sel.getRangeAt(0),node=document.createTextNode(t);
      r.deleteContents(); r.insertNode(node);
      r.setStartAfter(node); r.setEndAfter(node);
      sel.removeAllRanges(); sel.addRange(r);
    }
    notify(1); // a manual DOM change fires no input event, so the unsaved count must be reported by hand
  }

  // Paste is always handled as plain text: rich text would drag tags into the contenteditable, and we only write text back.
  //
  // [Why document.execCommand("insertText") is still used]
  // It has been marked deprecated since Chrome 127 and may be removed in the future, but it is
  // **currently still the only** way to get this insertion into the browser's native undo stack:
  // switch to manual Range manipulation and Ctrl+Z inside the contenteditable stops working on the
  // spot -- in a "double-click to change words" editor, losing undo is far worse than using a
  // deprecated API. So try it first, and fall back to insertPlainText only when it clearly fails
  // (returns false / throws / is actually removed one day).
  document.addEventListener("paste",function(e){
    if(!active||!active.span.contains(e.target)) return;
    e.preventDefault();
    var t=((e.clipboardData&&e.clipboardData.getData("text/plain"))||"").replace(/[\\r\\n]+/g," ");
    if(!t) return;
    var ok=false;
    try{ ok=(typeof document.execCommand==="function")&&document.execCommand("insertText",false,t)===true; }catch(err){ ok=false; }
    if(!ok) insertPlainText(t);
  });

  // Navigating away in edit mode means losing changes: off-site links and form submissions are always blocked; in-page anchors keep working.
  document.addEventListener("click",function(e){
    var t=e.target,a=(t&&t.nodeType===1&&t.closest)?t.closest("a[href]"):null;
    if(a&&(a.getAttribute("href")||"").charAt(0)!=="#") e.preventDefault();
  },true);
  document.addEventListener("submit",function(e){ e.preventDefault(); },true);

  // After a save, clear only the spots that **were actually written back to the source**. It used to be
  // patches={} wiping everything, taking the "could not be written back" ones with it: the page still
  // showed the new text, the unsaved badge vanished, and clicking save again only said "no changes yet"
  // -- those changes were silently lost, and the user never even got a chance to retry.
  function settle(keys){
    var i;
    if(Object.prototype.toString.call(keys)==="[object Array]"){
      for(i=0;i<keys.length;i++) delete patches[String(keys[i])];
    } else { patches={}; }
    notify(0);
  }

  function onPort(e){
    var d=e.data;
    if(!d||d.nonce!==NONCE) return;
    var t=d.type,list=[],k;
    if(t==="ah-editor:ping"){ announce(); }
    else if(t==="ah-editor:save"){
      commit(false);                              // the user may have clicked save without blurring first
      for(k in patches){ if(has(patches,k)) list.push(patches[k]); }
      post({type:"ah-editor:patch",patches:list});
    }
    else if(t==="ah-editor:saved"){ settle(d.keys); }
    // Preview mode: hand the page back to the artifact -- keys are no longer intercepted, double-click
    // no longer enters edit mode, and the artifact's keys, clicks and own controls all work as usual,
    // while **edited-but-unsaved text stays on the page and in patches** (which is why a message
    // toggles it instead of reloading the edit surface: a reload would wipe the pending changes).
    // Accept both field names: at the moment of deployment "old parent page, new injected script" can occur; do not break in that instant.
    else if(t==="ah-editor:mode"){
      previewing=!!(d.preview!==undefined?d.preview:d.play);
      if(previewing){
        commit(false);                  // settle the spot being edited before handing control back
        // Focus fallback: after the parent's button click, focus stays on the button (in the **parent document**) and keys never reach this frame.
        // The parent already calls iframe.focus(); ask once more here ourselves -- doing both means arrow keys work right after the user clicks preview.
        try{ window.focus(); }catch(err){}
      }
      post({type:"ah-editor:mode",previewing:previewing,playing:previewing});
    }
  }

  // Handshake: the parent transfers port2 along with the ping; from then on both sides use only this private channel (see the file header).
  // The parent keeps pinging until it receives ready (the iframe's load event may be held up by slow
  // resources), so swapping in a new port is allowed here -- only the parent itself can produce an event that is isTrusted with source===PARENT.
  function onWindow(e){
    if(readOf(G_TRUST,e,"isTrusted")===false) return;   // a fake event fabricated via dispatchEvent
    if(readOf(G_SOURCE,e,"source")!==PARENT) return;    // the page postMessage-ing itself
    var d=e.data;
    if(!d||d.type!=="ah-editor:ping"||d.nonce!==NONCE) return;
    var ports=readOf(G_PORTS,e,"ports");
    if(!ports||!ports.length||!ports[0]) return;
    // Cut dispatch right here: this script is the first <script> in the document, so this listener
    // precedes any message listener an artifact script registers; after stopImmediatePropagation they never even see the event, hence never get the port.
    if(typeof e.stopImmediatePropagation==="function") e.stopImmediatePropagation();
    if(port&&P_CLOSE){ try{ P_CLOSE.call(port); }catch(err){} }
    port=ports[0];
    if(P_ON) P_ON.call(port,"message",onPort); else port.addEventListener("message",onPort);
    if(P_START) P_START.call(port); else if(port.start) port.start();
    announce();
  }
  window.addEventListener("message",onWindow);

  function later(fn){ try{ setTimeout(fn,0); }catch(e){ fn(); } }

  function boot(){
    if(booted) return;
    booted=true;
    paint(); announce();
    // Stats are reported twice, because the two numbers become accurate at different moments:
    //   - editable (how many pieces can be edited) is accurate right now -- marks come from the source,
    //     the DOM is fully parsed by this point, and cloning only **adds** copies and can never disqualify
    //     an original (first-seen wins). So report once now; the toolbar need not sit empty waiting.
    //   - script (script-generated text) is only accurate after the artifact's scripts have run:
    //     thumbnail panels, carousels and the like are built in load. So report again one tick after
    //     load (setTimeout 0, letting all load handlers finish).
    // The parent lets the later report override; the numbers only move from "under-reporting uneditable" towards "accurate", never the other way.
    measure();
    if(document.readyState==="complete") later(measure);
    else window.addEventListener("load",function(){ later(measure); });
  }
  // Wait for the DOM before applying styles; ready is only sent once "booted and port received". The
  // parent has a deadline: if it is not met, it switches to an error state and explains why, never spinning forever.
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
})();`;

/** The script body carrying this request's nonce. The nonce only pairs replies with this editing session; it is not a secret. */
export function editorBootstrapScript(nonce: string): string {
  return BOOTSTRAP.replace("__NONCE__", JSON.stringify(nonce));
}
