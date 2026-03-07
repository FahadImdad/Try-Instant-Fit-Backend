"use strict";(()=>{var h="https://backend-tryinstantfit.vercel.app",b=class{constructor(e){this.config=null;this.overlayRoot=null;this.overlayShadow=null;this.currentProduct=null;this.isImageOverlay=!1;this.cameraStream=null;this.selectedFile=null;this.countdownTimer=null;this.lightingInterval=null;this.lastBrightness=128;this.selectedProvider="primary";this.brandId=e,this.init()}async init(){try{if(console.log("[GhostLayer] Initializing for brand:",this.brandId),await this.loadConfiguration(),this.config?.buttonColor&&document.documentElement.style.setProperty("--gl-brand-color",this.config.buttonColor),!this.config?.enabled){console.log("[GhostLayer] Widget disabled");return}if(this.isProductPage()){if(this.currentProduct=this.detectProduct(),!this.currentProduct){console.log("[GhostLayer] No product detected");return}console.log("[GhostLayer] Product:",this.currentProduct.name),this.injectButton(),this.trackEvent("widget_loaded",{product_id:this.currentProduct.id}),new URLSearchParams(window.location.search).get("tryon")==="1"&&setTimeout(()=>this.openOverlay(),500)}else console.log("[GhostLayer] Scanning for product cards on listing page"),this.injectOverlayRoot(),document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>this.scanListingPage()):this.scanListingPage()}catch(e){console.error("[GhostLayer] Init error:",e)}}async loadConfiguration(){try{let e=await fetch(`${h}/api/widget/config/${this.brandId}`,{headers:{Accept:"application/json"}});if(e.ok){this.config=await e.json();return}}catch{}this.config={brandId:this.brandId,apiEndpoint:h,buttonText:"Try It On \u2728",buttonColor:"#1a1a2e",buttonPosition:"bottom-right",enabled:!0}}isProductPage(){for(let s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')))try{let d=JSON.parse(s.textContent||"");if((Array.isArray(d)?d:[d]).some(u=>u["@type"]==="Product"))return!0}catch{}if((document.querySelector('meta[property="og:type"]')?.getAttribute("content")||"").toLowerCase().includes("product"))return!0;let t=window.location.pathname.toLowerCase(),o=window.location.search.toLowerCase();if(["/product/","/products/","/p/","/item/","/shop/","/clothing/","product.html"].some(s=>t.includes(s))||o.includes("id=")&&t.includes("product"))return!0;let n=!!(document.querySelector('[class*="price"]')||document.querySelector('[itemprop="price"]')),i=!!(document.querySelector('[class*="add-to-cart"]')||document.querySelector('[class*="addtocart"]')||document.querySelector('button[name="add"]')),a=!!(document.querySelector('[class*="product-image"]')||document.querySelector('[class*="product-gallery"]'));return n&&(i||a)}scanListingPage(){this.findProductCards().forEach(t=>this.injectCardButton(t)),new MutationObserver(()=>{this.findProductCards().forEach(t=>this.injectCardButton(t))}).observe(document.body,{childList:!0,subtree:!0})}findProductCards(){let e=[".card-wrapper",".grid__item .card",".product-card","li.product",".woocommerce-loop-product__link",".product-item",".product-grid-item",".grid-product",'[class*="product-card"]','[class*="ProductCard"]','[class*="product-item"]','[class*="ProductItem"]','[class*="product-tile"]','[class*="ProductTile"]',"[data-product-id]","[data-product]"],t=new Set;for(let o of e)document.querySelectorAll(o).forEach(r=>{!r.dataset.glInjected&&r.querySelector("img")&&t.add(r)});return Array.from(t)}injectCardButton(e){e.dataset.glInjected="1";let t=Array.from(e.querySelectorAll("img")).find(g=>g.width>60&&!this.isPlaceholder(g.src)&&g.src);if(!t)return;let r=e.querySelector('h2, h3, h4, [class*="title"], [class*="name"], [class*="product-name"], [class*="card-title"]')?.textContent?.trim()||"Product",i=e.querySelector("a[href]")?.href||location.href,a=Math.random().toString(36).substr(2,12),s=e.dataset.id||e.dataset.productId||e.getAttribute("data-product-id")||e.closest("[data-id]")?.getAttribute("data-id")||e.closest("[data-product-id]")?.getAttribute("data-product-id");if(s)a=s;else try{let g=new URLSearchParams(new URL(i,location.href).search);a=g.get("id")||g.get("product_id")||g.get("productId")||a}catch{}let d={id:a,name:r,imageUrl:t.src,url:i},p=t.parentElement;getComputedStyle(p).position==="static"&&(p.style.position="relative");let u=this.config?.buttonColor||"#1a1a2e",c=document.createElement("button");c.textContent="Try It On \u2728",c.className="gl-card-tryon-btn",Object.assign(c.style,{position:"absolute",bottom:"12px",right:"12px",zIndex:"10",background:u,color:"#fff",border:"none",borderRadius:"50px",padding:"8px 16px",fontSize:"12px",fontWeight:"700",cursor:"pointer",boxShadow:"0 2px 12px rgba(0,0,0,0.3)",fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',whiteSpace:"nowrap",letterSpacing:"0.3px",transition:"transform 0.18s, box-shadow 0.18s, filter 0.18s"}),c.addEventListener("mouseover",()=>{c.style.transform="translateY(-2px)",c.style.boxShadow="0 6px 20px rgba(0,0,0,0.4)",c.style.filter="brightness(1.12)"}),c.addEventListener("mouseout",()=>{c.style.transform="",c.style.boxShadow="0 2px 12px rgba(0,0,0,0.3)",c.style.filter=""}),c.addEventListener("click",g=>{g.preventDefault(),g.stopPropagation(),this.openForProduct(d)}),p.appendChild(c)}detectProduct(){return this.fromSchema()||this.fromOG()||this.fromDOM()}fromSchema(){for(let e of Array.from(document.querySelectorAll('script[type="application/ld+json"]')))try{let t=JSON.parse(e.textContent||""),r=(Array.isArray(t)?t:[t]).find(i=>i["@type"]==="Product");if(!r)continue;let n=Array.isArray(r.image)?r.image[0]:r.image;if(!n)continue;return{id:r.sku||r["@id"]||this.genId(),name:r.name||document.title,imageUrl:n,price:r.offers?.price?.toString(),url:location.href}}catch{}return null}fromOG(){let e=document.querySelector('meta[property="og:image"]')?.getAttribute("content"),t=document.querySelector('meta[property="og:title"]')?.getAttribute("content");return e&&t?{id:this.genId(),name:t,imageUrl:e,url:location.href}:null}fromDOM(){let e=["#pd-main-img","#product-featured-image",".product-image img",".product-gallery img",".product-single__media img",".product-featured-image img",".woocommerce-product-gallery__image img","[data-product-image] img",'[class*="pd-main"] img','[class*="product"] img',"main img"],t="";for(let n of e){let i=document.querySelector(n);if(!i)continue;let a=i.tagName==="IMG"?i:i.querySelector("img");if(a?.src&&!this.isPlaceholder(a.src)){t=a.src;break}}let o=["#pd-name",'h1[class*="product"]','[class*="product-title"]','[class*="product-name"]','[itemprop="name"]',"h1"],r="";for(let n of o){let i=document.querySelector(n)?.textContent?.trim();if(i){r=i;break}}return t&&r?{id:this.genId(),name:r,imageUrl:t,url:location.href}:null}isPlaceholder(e){let t=e.toLowerCase();return t.includes("placeholder")||t.includes("no-image")||t.includes("noimage")||t.includes("icon")||t.includes("logo")}genId(){let e=new URLSearchParams(location.search),t=e.get("id")||e.get("product_id")||e.get("productId");return t||btoa(location.pathname).replace(/[^a-zA-Z0-9]/g,"").substring(0,16)}findProductImg(){let e=["#pd-main-img","#product-featured-image",".product-featured-image img",".product-single__media img",".product-image img",".woocommerce-product-gallery__image img",'[class*="product-gallery"] img','[class*="product-image"] img','[class*="product-photo"] img','[class*="product-media"] img'];for(let t of e){let o=document.querySelector(t);if(o instanceof HTMLImageElement&&o.src&&!this.isPlaceholder(o.src))return o}return null}injectButton(){let e=this.config?.buttonColor||"#1a1a2e",t=this.config?.buttonText||"Try It On \u2728",o=document.createElement("div");o.id="ghostlayer-btn-root";let r=this.findProductImg();if(r){this.isImageOverlay=!0;let i=r.parentElement;i?(getComputedStyle(i).position==="static"&&(i.style.position="relative"),Object.assign(o.style,{position:"absolute",top:"14px",right:"14px",zIndex:"100",pointerEvents:"auto"}),i.appendChild(o)):(document.body.appendChild(o),this.isImageOverlay=!1)}else document.body.appendChild(o),this.isImageOverlay=!1;let n=o.attachShadow({mode:"open"});if(this.isImageOverlay)n.innerHTML=`
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          button {
            display: block;
            background: ${e};
            color: #fff;
            border: none;
            border-radius: 50px;
            padding: 11px 26px;
            font-size: 14px;
            font-weight: 700;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            white-space: nowrap;
            letter-spacing: 0.3px;
            transition: transform 0.2s, box-shadow 0.2s, filter 0.2s;
          }
          button:hover { transform: translateY(-2px); box-shadow: 0 8px 26px rgba(0,0,0,0.5); filter: brightness(1.12); }
          button:active { transform: translateY(0); }
        </style>
        <button id="gl-try-btn">${t}</button>
      `;else{let i=this.config?.buttonPosition||"bottom-right",a={"bottom-right":"bottom:24px;right:24px;","bottom-left":"bottom:24px;left:24px;","top-right":"top:24px;right:24px;","top-left":"top:24px;left:24px;"};n.innerHTML=`
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          button {
            position: fixed;
            ${a[i]||a["bottom-right"]}
            background: ${e};
            color: #fff;
            border: none;
            border-radius: 50px;
            padding: 14px 28px;
            font-size: 15px;
            font-weight: 700;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0,0,0,0.25);
            z-index: 2147483646;
            white-space: nowrap;
            letter-spacing: 0.3px;
            transition: transform 0.2s, box-shadow 0.2s;
          }
          button:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,0.3); }
          button:active { transform: translateY(0); }
        </style>
        <button id="gl-try-btn">${t}</button>
      `}n.getElementById("gl-try-btn")?.addEventListener("click",()=>this.openOverlay()),this.injectOverlayRoot()}injectOverlayRoot(){this.overlayRoot||(this.overlayRoot=document.createElement("div"),this.overlayRoot.id="ghostlayer-overlay-root",document.body.appendChild(this.overlayRoot),this.overlayShadow=this.overlayRoot.attachShadow({mode:"open"}))}openOverlay(){this.trackEvent("tryon_opened",{product_id:this.currentProduct?.id}),this.selectedFile=null,this.renderOverlay("upload")}openForProduct(e){this.config?.enabled&&(this.overlayRoot||this.injectOverlayRoot(),this.currentProduct=e,this.openOverlay())}renderOverlay(e,t){if(!this.overlayShadow)return;let o=this.overlayShadow.getElementById("gl-overlay");o&&o.remove();let r=document.createElement("div");r.id="gl-overlay",r.innerHTML=this.getOverlayInner(e,t),this.overlayShadow.appendChild(r),this.bindOverlayEvents(e)}getOverlayInner(e,t){let o=this.currentProduct?.name||"this item",r=this.currentProduct?.imageUrl||"",i={upload:`
        <div class="gl-card">
          <div class="gl-header">
            <div class="gl-logo">\u2728 Try It On</div>
            <button class="gl-close" id="gl-close">\u2715</button>
          </div>
          ${r?`<div class="gl-product-preview">
           <img src="${r}" alt="${o}" class="gl-product-img" />
           <div class="gl-product-name">${o}</div>
         </div>
         <div class="gl-divider"></div>`:""}
          <p class="gl-subtitle">Upload your photo or use your camera to see how this looks on you</p>

          <div class="gl-tabs">
            <button class="gl-tab gl-tab-active" id="gl-tab-upload">\u{1F4C1} Upload</button>
            <button class="gl-tab" id="gl-tab-camera">\u{1F4F7} Camera</button>
          </div>

          <!-- Upload Panel -->
          <div id="gl-panel-upload">
            <div class="gl-upload-zone" id="gl-upload-zone">
              <div class="gl-upload-icon">\u{1F4F8}</div>
              <div class="gl-upload-text">Click to upload your photo</div>
              <div class="gl-upload-hint">or drag & drop \xB7 JPG, PNG, WEBP \xB7 Max 10MB</div>
              <input type="file" id="gl-file-input" accept="image/jpeg,image/png,image/webp" hidden />
            </div>
            <div class="gl-preview-wrap" id="gl-upload-preview-wrap" style="display:none">
              <img id="gl-upload-preview-img" class="gl-preview-img" src="" alt="Your photo" />
              <button class="gl-change-btn" id="gl-change-photo">Change photo</button>
            </div>
          </div>

          <!-- Camera Panel -->
          <div id="gl-panel-camera" style="display:none">
            <div class="gl-lighting-bar" id="gl-lighting-bar">
              <span class="gl-lighting-dot" id="gl-lighting-dot"></span>
              <span class="gl-lighting-text" id="gl-lighting-text">Starting camera...</span>
            </div>
            <div class="gl-camera-wrap" id="gl-camera-wrap">
              <video id="gl-camera-video" class="gl-camera-video" autoplay playsinline muted></video>
              <canvas id="gl-camera-canvas" style="display:none" width="640" height="480"></canvas>
<div class="gl-countdown-overlay" id="gl-countdown-overlay" style="display:none">
                <div class="gl-countdown-num" id="gl-countdown-num">5</div>
              </div>
            </div>
            <p class="gl-camera-tip">\u{1F4A1} Stand upright \xB7 Full body \xB7 Face forward \u2014 for best results</p>
            <div class="gl-camera-controls" id="gl-camera-controls">
              <button class="gl-cam-btn gl-capture-btn" id="gl-capture-now" disabled>\u{1F4F8} Capture Now</button>
              <button class="gl-cam-btn gl-timer-btn" id="gl-timer-btn" disabled>\u23F1 5s Timer</button>
            </div>
            <div class="gl-camera-error" id="gl-camera-error" style="display:none">
              \u{1F4F5} Camera not available. Allow camera access or use Upload instead.
            </div>
            <div class="gl-preview-wrap" id="gl-camera-preview-wrap" style="display:none">
              <img id="gl-camera-preview-img" class="gl-preview-img" src="" alt="Captured photo" />
              <button class="gl-change-btn" id="gl-retake-btn">\u21A9 Retake</button>
            </div>
          </div>

          <div class="gl-model-toggle">
            <span class="gl-model-label">AI Model:</span>
            <button class="gl-model-btn gl-model-active" id="gl-model-primary" data-provider="primary">\u2B50 Google Try-On</button>
            <button class="gl-model-btn" id="gl-model-fallback" data-provider="fallback">\u{1F916} Gemini</button>
          </div>

          <button class="gl-primary-btn" id="gl-generate-btn" disabled>Generate Try-On</button>
          <div class="gl-result-actions">
            <button class="gl-secondary-btn" id="gl-wl-btn-upload">\u2661 Wishlist</button>
            <button class="gl-secondary-btn gl-buy-btn" id="gl-buy-btn-upload">\u{1F6D2} Add to Cart</button>
          </div>
          <p class="gl-privacy">\u{1F512} Your photo is never stored. Processed securely and deleted immediately.</p>
        </div>
      `,processing:`
        <div class="gl-card gl-center">
          <div class="gl-spinner"></div>
          <div class="gl-processing-title">Creating your look...</div>
          <div class="gl-processing-sub">Our AI is styling you right now \u2728</div>
          <div class="gl-progress-bar"><div class="gl-progress-fill"></div></div>
        </div>
      `,result:`
        <div class="gl-card">
          <div class="gl-header">
            <div class="gl-logo">\u2728 Your Look</div>
            <button class="gl-close" id="gl-close">\u2715</button>
          </div>
          <img src="${t?.resultUrl||""}" alt="Virtual try-on result" class="gl-result-img" />
          <div class="gl-result-actions">
            <button class="gl-secondary-btn" id="gl-retry">Try Another Photo</button>
            <button class="gl-secondary-btn" id="gl-wl-btn">\u2661 Wishlist</button>
            <button class="gl-primary-btn gl-buy-btn" id="gl-buy-btn">\u{1F6D2} Add to Cart</button>
          </div>
          <p class="gl-privacy">Powered by <strong>Try Instant Fit</strong></p>
        </div>
      `,error:`
        <div class="gl-card gl-center">
          <div class="gl-error-icon">\u26A0\uFE0F</div>
          <div class="gl-error-title">Something went wrong</div>
          <div class="gl-error-msg">${t?.errorMsg||"Please try again with a clear, front-facing photo."}</div>
          <button class="gl-primary-btn" id="gl-retry">Try Again</button>
          <button class="gl-ghost-btn" id="gl-close">Close</button>
        </div>
      `};return`<style>${this.css()}</style>${i[e]}`}css(){return`
      * { box-sizing: border-box; margin: 0; padding: 0; }

      #gl-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.72);
        backdrop-filter: blur(4px);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: gl-fade-in 0.2s ease;
      }
      @keyframes gl-fade-in { from { opacity: 0 } to { opacity: 1 } }

      .gl-card {
        background: #fff;
        border-radius: 20px;
        width: 420px;
        max-width: calc(100vw - 32px);
        max-height: 90vh;
        overflow-y: auto;
        padding: 24px 24px 20px;
        box-shadow: 0 24px 64px rgba(0,0,0,0.32);
        animation: gl-slide-up 0.28s ease;
        scrollbar-width: thin;
      }
      @keyframes gl-slide-up {
        from { transform: translateY(18px); opacity: 0 }
        to   { transform: translateY(0);    opacity: 1 }
      }

      .gl-center { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; }

      .gl-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .gl-logo { font-size: 16px; font-weight: 700; color: #1a1a2e; }
      .gl-close {
        background: #f3f4f6; border: none; border-radius: 50%;
        width: 30px; height: 30px; cursor: pointer; font-size: 13px;
        color: #6b7280; display: flex; align-items: center; justify-content: center;
        transition: background 0.2s; flex-shrink: 0;
      }
      .gl-close:hover { background: #e5e7eb; }

      .gl-product-preview { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
      .gl-product-img { width: 52px; height: 66px; object-fit: cover; border-radius: 8px; border: 1px solid #e5e7eb; flex-shrink: 0; }
      .gl-product-name { font-size: 13px; font-weight: 600; color: #111; line-height: 1.4; }
      .gl-divider { height: 1px; background: #f3f4f6; margin: 0 0 14px; }

      .gl-subtitle { font-size: 12px; color: #6b7280; margin-bottom: 12px; line-height: 1.5; }

      /* Tabs */
      .gl-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
      .gl-tab {
        flex: 1; padding: 9px 10px; border: 1.5px solid #e5e7eb; border-radius: 10px;
        background: #fff; font-size: 13px; font-weight: 600; color: #6b7280;
        cursor: pointer; transition: all 0.18s;
      }
      .gl-tab:hover { border-color: #374151; color: #374151; }
      .gl-tab-active { background: #1a1a2e; border-color: #1a1a2e; color: #fff; }

      /* Upload */
      .gl-upload-zone {
        border: 2px dashed #d1d5db; border-radius: 12px; padding: 26px 16px;
        text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s;
        margin-bottom: 12px;
      }
      .gl-upload-zone:hover, .gl-upload-zone.gl-drag-over { border-color: #6366f1; background: #f5f3ff; }
      .gl-upload-icon { font-size: 30px; margin-bottom: 8px; }
      .gl-upload-text { font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 3px; }
      .gl-upload-hint { font-size: 11px; color: #9ca3af; }

      /* Camera */
      .gl-camera-wrap {
        position: relative; border-radius: 12px; overflow: hidden;
        background: #111; margin-bottom: 10px; aspect-ratio: 4/3;
      }
      .gl-camera-video {
        width: 100%; height: 100%; object-fit: cover; display: block;
        transform: scaleX(-1); /* mirror like a selfie */
      }
      .gl-countdown-overlay {
        position: absolute; inset: 0; background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
      }
      .gl-countdown-num {
        font-size: 88px; font-weight: 900; color: #fff;
        animation: gl-pulse 1s ease infinite;
        text-shadow: 0 2px 20px rgba(0,0,0,0.5);
        line-height: 1;
      }
      @keyframes gl-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50%       { transform: scale(1.08); opacity: 0.9; }
      }
      .gl-camera-tip { font-size: 11px; color: #6b7280; text-align: center; margin-bottom: 8px; }
      .gl-camera-controls { display: flex; gap: 8px; margin-bottom: 10px; }
      .gl-cam-btn {
        flex: 1; padding: 11px 8px; border-radius: 10px; border: none;
        font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.18s;
      }
      .gl-cam-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .gl-capture-btn { background: #1a1a2e; color: #fff; }
      .gl-capture-btn:hover:not(:disabled) { background: #2d2d4e; }
      .gl-timer-btn { background: #f3f4f6; color: #374151; }
      .gl-timer-btn:hover:not(:disabled) { background: #e5e7eb; }
      .gl-camera-error {
        font-size: 12px; color: #ef4444; text-align: center;
        padding: 10px 12px; background: #fef2f2; border-radius: 8px; margin-bottom: 10px;
      }

      /* Lighting indicator */
      .gl-lighting-bar {
        display: flex; align-items: center; gap: 7px;
        padding: 6px 10px; border-radius: 8px;
        background: #f9fafb; border: 1px solid #e5e7eb;
        margin-bottom: 8px; font-size: 12px; color: #374151;
      }
      .gl-lighting-dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #9ca3af; flex-shrink: 0;
        transition: background 0.4s;
      }
      .gl-lighting-text { font-weight: 500; flex: 1; }

      /* Preview */
      .gl-preview-wrap { position: relative; margin-bottom: 12px; text-align: center; }
      .gl-preview-img {
        width: 100%; max-height: 210px; object-fit: contain;
        border-radius: 12px; border: 1px solid #e5e7eb;
      }
      .gl-change-btn {
        margin-top: 7px; background: none; border: none;
        color: #6366f1; font-size: 13px; font-weight: 600;
        cursor: pointer; text-decoration: underline;
      }

      /* Buttons */
      .gl-primary-btn {
        width: 100%; padding: 13px; background: #1a1a2e; color: #fff;
        border: none; border-radius: 12px; font-size: 14px; font-weight: 700;
        cursor: pointer; transition: background 0.2s; margin-bottom: 6px;
      }
      .gl-primary-btn:hover:not(:disabled) { background: #2d2d4e; }
      .gl-primary-btn:disabled { opacity: 0.38; cursor: not-allowed; }
      .gl-buy-btn { width: auto; flex: 1; }
      .gl-secondary-btn {
        flex: 1; padding: 11px 12px; background: #f3f4f6; color: #374151;
        border: none; border-radius: 10px; font-size: 13px; font-weight: 600;
        cursor: pointer; text-align: center; text-decoration: none;
        display: inline-block; transition: background 0.2s;
      }
      .gl-secondary-btn:hover { background: #e5e7eb; }
      .gl-ghost-btn {
        width: 100%; padding: 11px; background: none;
        border: 2px solid #e5e7eb; border-radius: 12px;
        font-size: 13px; font-weight: 600; color: #6b7280;
        cursor: pointer; margin-top: 6px;
      }
      .gl-ghost-btn:hover { border-color: #d1d5db; }

      .gl-privacy { font-size: 11px; color: #9ca3af; text-align: center; margin-top: 8px; line-height: 1.4; }
      .gl-model-toggle { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
      .gl-model-label { font-size: 11px; color: #6b7280; white-space: nowrap; }
      .gl-model-btn { flex: 1; padding: 6px 10px; border: 1.5px solid #e5e7eb; border-radius: 8px; background: #f9fafb; color: #6b7280; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
      .gl-model-btn:hover { border-color: #6366f1; color: #6366f1; }
      .gl-model-active { border-color: #6366f1 !important; background: #f5f3ff !important; color: #6366f1 !important; }

      /* Processing */
      .gl-spinner {
        width: 52px; height: 52px; border: 4px solid #e5e7eb;
        border-top-color: #6366f1; border-radius: 50%;
        animation: gl-spin 0.75s linear infinite;
      }
      @keyframes gl-spin { to { transform: rotate(360deg); } }
      .gl-processing-title { font-size: 17px; font-weight: 700; color: #111; }
      .gl-processing-sub { font-size: 13px; color: #6b7280; }
      .gl-progress-bar { width: 100%; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden; }
      .gl-progress-fill {
        height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6);
        animation: gl-progress 4s ease-in-out forwards;
      }
      @keyframes gl-progress {
        0%   { width: 0%; }
        30%  { width: 40%; }
        70%  { width: 72%; }
        90%  { width: 86%; }
        100% { width: 90%; }
      }

      /* Result */
      .gl-result-img { width: 100%; border-radius: 14px; border: 1px solid #e5e7eb; margin-bottom: 14px; }
      .gl-result-actions { display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; align-items: center; }

      /* Error */
      .gl-error-icon { font-size: 44px; }
      .gl-error-title { font-size: 17px; font-weight: 700; color: #111; }
      .gl-error-msg { font-size: 13px; color: #6b7280; line-height: 1.5; }
    `}bindOverlayEvents(e){let t=this.overlayShadow;if(t){if(t.getElementById("gl-close")?.addEventListener("click",()=>this.closeOverlay()),t.getElementById("gl-overlay")?.addEventListener("click",o=>{o.target.id==="gl-overlay"&&this.closeOverlay()}),e==="upload"){let o=t.getElementById("gl-generate-btn"),r=l=>{this.selectedFile=l,o&&(o.disabled=!1)},n=t.getElementById("gl-tab-upload"),i=t.getElementById("gl-tab-camera"),a=t.getElementById("gl-panel-upload"),s=t.getElementById("gl-panel-camera");n?.addEventListener("click",()=>{this.stopCamera(),n.classList.add("gl-tab-active"),i?.classList.remove("gl-tab-active"),a&&(a.style.display="block"),s&&(s.style.display="none")}),i?.addEventListener("click",async()=>{i.classList.add("gl-tab-active"),n?.classList.remove("gl-tab-active"),a&&(a.style.display="none"),s&&(s.style.display="block"),await this.startCamera(t)});let d=t.getElementById("gl-upload-zone"),p=t.getElementById("gl-file-input"),u=t.getElementById("gl-upload-preview-wrap"),c=t.getElementById("gl-upload-preview-img"),g=l=>{if(!l.type.startsWith("image/"))return;r(l);let m=URL.createObjectURL(l);c&&(c.src=m),d&&(d.style.display="none"),u&&(u.style.display="block")};d?.addEventListener("click",()=>p?.click()),t.getElementById("gl-change-photo")?.addEventListener("click",()=>{this.selectedFile=null,o&&(o.disabled=!0),d&&(d.style.display="block"),u&&(u.style.display="none"),p?.click()}),p?.addEventListener("change",()=>{let l=p.files?.[0];l&&g(l)}),d?.addEventListener("dragover",l=>{l.preventDefault(),d.classList.add("gl-drag-over")}),d?.addEventListener("dragleave",()=>d.classList.remove("gl-drag-over")),d?.addEventListener("drop",l=>{l.preventDefault(),d.classList.remove("gl-drag-over");let m=l.dataTransfer?.files[0];m&&g(m)}),t.getElementById("gl-capture-now")?.addEventListener("click",()=>{this.capturePhoto(t,r)}),t.getElementById("gl-timer-btn")?.addEventListener("click",()=>{this.startCountdown(t,5,r)}),t.getElementById("gl-retake-btn")?.addEventListener("click",async()=>{this.selectedFile=null,o&&(o.disabled=!0);let l=t.getElementById("gl-camera-preview-wrap"),m=t.getElementById("gl-camera-wrap"),y=t.getElementById("gl-camera-controls"),f=t.getElementById("gl-capture-now"),v=t.getElementById("gl-timer-btn"),x=t.getElementById("gl-lighting-bar");l&&(l.style.display="none"),m&&(m.style.display="block"),y&&(y.style.display="flex"),x&&(x.style.display="flex"),f&&(f.disabled=!0),v&&(v.disabled=!0),await this.startCamera(t)}),o?.addEventListener("click",async()=>{this.selectedFile&&await this.generateTryOn(this.selectedFile)}),t.getElementById("gl-model-primary")?.addEventListener("click",()=>{this.selectedProvider="primary",t.getElementById("gl-model-primary")?.classList.add("gl-model-active"),t.getElementById("gl-model-fallback")?.classList.remove("gl-model-active")}),t.getElementById("gl-model-fallback")?.addEventListener("click",()=>{this.selectedProvider="fallback",t.getElementById("gl-model-fallback")?.classList.add("gl-model-active"),t.getElementById("gl-model-primary")?.classList.remove("gl-model-active")}),t.getElementById("gl-buy-btn-upload")?.addEventListener("click",()=>{let l=this.currentProduct?.id;this.trackEvent("buy_clicked",{product_id:l}),l&&window.glAddToCart?window.glAddToCart(l):(document.querySelector('button[name="add"]')||document.querySelector('[class*="add-to-cart"]'))?.click(),this.closeOverlay()}),t.getElementById("gl-wl-btn-upload")?.addEventListener("click",()=>{let l=this.currentProduct?.id;if(this.trackEvent("wishlist_clicked",{product_id:l}),l&&window.glAddToWL){window.glAddToWL(l);let m=t.getElementById("gl-wl-btn-upload");m&&(m.textContent="\u2665 Wishlisted")}})}e==="result"&&(t.getElementById("gl-retry")?.addEventListener("click",()=>{this.selectedFile=null,this.renderOverlay("upload")}),t.getElementById("gl-buy-btn")?.addEventListener("click",()=>{let o=this.currentProduct?.id;this.trackEvent("buy_clicked",{product_id:o}),o&&window.glAddToCart?window.glAddToCart(o):(document.querySelector('button[name="add"]')||document.querySelector('[class*="add-to-cart"]'))?.click(),this.closeOverlay()}),t.getElementById("gl-wl-btn")?.addEventListener("click",()=>{let o=this.currentProduct?.id;if(this.trackEvent("wishlist_clicked",{product_id:o}),o&&window.glAddToWL){window.glAddToWL(o);let r=t.getElementById("gl-wl-btn");r&&(r.textContent="\u2665 Wishlisted")}})),e==="error"&&t.getElementById("gl-retry")?.addEventListener("click",()=>{this.selectedFile=null,this.renderOverlay("upload")})}}async startCamera(e){let t=e.getElementById("gl-camera-video"),o=e.getElementById("gl-camera-error"),r=e.getElementById("gl-capture-now"),n=e.getElementById("gl-timer-btn"),i=e.getElementById("gl-camera-wrap");this.stopCamera();try{let a=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:480}}});this.cameraStream=a,t&&(t.srcObject=a),i&&(i.style.display="block"),o&&(o.style.display="none"),this.monitorLighting(e)}catch{o&&(o.style.display="block"),i&&(i.style.display="none"),r&&(r.disabled=!0),n&&(n.disabled=!0)}}capturePhoto(e,t){let o=e.getElementById("gl-camera-video"),r=e.getElementById("gl-camera-canvas");if(!o||!r||!o.videoWidth)return;r.width=o.videoWidth,r.height=o.videoHeight;let n=r.getContext("2d");if(n){if(this.lastBrightness>0&&this.lastBrightness<80){let i=Math.min(2,100/Math.max(this.lastBrightness,20));n.filter=`brightness(${i.toFixed(2)})`}n.drawImage(o,0,0),n.filter="none",this.stopCamera(),r.toBlob(i=>{if(!i)return;let a=new File([i],"selfie.jpg",{type:"image/jpeg"}),s=e.getElementById("gl-camera-wrap"),d=e.getElementById("gl-camera-controls"),p=e.getElementById("gl-lighting-bar"),u=e.getElementById("gl-camera-preview-wrap"),c=e.getElementById("gl-camera-preview-img"),g=URL.createObjectURL(a);c&&(c.src=g),s&&(s.style.display="none"),d&&(d.style.display="none"),p&&(p.style.display="none"),u&&(u.style.display="block"),t(a)},"image/jpeg",.92)}}monitorLighting(e){this.lightingInterval&&(clearInterval(this.lightingInterval),this.lightingInterval=null);let t=e.getElementById("gl-camera-video"),o=e.getElementById("gl-lighting-dot"),r=e.getElementById("gl-lighting-text"),n=e.getElementById("gl-capture-now"),i=e.getElementById("gl-timer-btn"),a=document.createElement("canvas");a.width=64,a.height=48;let s=a.getContext("2d");this.lightingInterval=window.setInterval(()=>{if(!s||!t||!t.videoWidth)return;s.drawImage(t,0,0,64,48);let d=s.getImageData(0,0,64,48).data,p=0;for(let l=0;l<d.length;l+=4)p+=.299*d[l]+.587*d[l+1]+.114*d[l+2];let u=p/(64*48);this.lastBrightness=u;let c=u>=80,g=u>=50;o&&(o.style.background=c?"#22c55e":g?"#f59e0b":"#ef4444"),r&&(r.textContent=c?"\u2713 Good lighting":g?"\u26A0 Brighter light will improve results":"\u2717 Too dark \u2014 move to better lighting"),this.countdownTimer||(n&&(n.disabled=!g),i&&(i.disabled=!g))},500)}startCountdown(e,t,o){let r=e.getElementById("gl-countdown-overlay"),n=e.getElementById("gl-countdown-num"),i=e.getElementById("gl-capture-now"),a=e.getElementById("gl-timer-btn");this.countdownTimer&&(clearInterval(this.countdownTimer),this.countdownTimer=null),r&&(r.style.display="flex"),i&&(i.disabled=!0),a&&(a.disabled=!0);let s=t;n&&(n.textContent=String(s)),this.countdownTimer=window.setInterval(()=>{s--,n&&(n.textContent=String(s)),s<=0&&(clearInterval(this.countdownTimer),this.countdownTimer=null,r&&(r.style.display="none"),i&&(i.disabled=!1),a&&(a.disabled=!1),this.capturePhoto(e,o))},1e3)}stopCamera(){this.countdownTimer&&(clearInterval(this.countdownTimer),this.countdownTimer=null),this.lightingInterval&&(clearInterval(this.lightingInterval),this.lightingInterval=null),this.cameraStream&&(this.cameraStream.getTracks().forEach(e=>e.stop()),this.cameraStream=null)}closeOverlay(){this.stopCamera(),this.overlayShadow?.getElementById("gl-overlay")?.remove(),this.trackEvent("tryon_closed",{product_id:this.currentProduct?.id})}tryOnCacheKey(e){return`gl_tryon_${this.currentProduct?.id}_${e.name}_${e.size}`}async generateTryOn(e){this.stopCamera();let t=this.tryOnCacheKey(e),o=sessionStorage.getItem(t);if(o){this.trackEvent("tryon_completed",{product_id:this.currentProduct?.id,result_url:o,cached:!0}),this.renderOverlay("result",{resultUrl:o});return}this.renderOverlay("processing"),this.trackEvent("tryon_started",{product_id:this.currentProduct?.id});try{let r=new FormData;r.append("user_photo",e),r.append("product_image_url",this.currentProduct?.imageUrl||""),r.append("product_id",this.currentProduct?.id||""),r.append("product_name",this.currentProduct?.name||""),r.append("brand_id",this.brandId),r.append("source","ghost-layer"),r.append("provider",this.selectedProvider);let n=await fetch(`${h}/api/widget/try-on`,{method:"POST",body:r});if(!n.ok){let s=await n.json().catch(()=>({}));throw new Error(s.debug||s.error||`Server error: ${n.status}`)}let i=await n.json(),a=i.result_url||i.resultUrl;if(!a)throw new Error("No result image returned");try{sessionStorage.setItem(t,a)}catch{}this.trackEvent("tryon_completed",{product_id:this.currentProduct?.id,result_url:a}),this.renderOverlay("result",{resultUrl:a})}catch(r){console.error("[GhostLayer] Try-on failed:",r),this.trackEvent("tryon_failed",{product_id:this.currentProduct?.id,error:String(r)}),this.renderOverlay("error",{errorMsg:r instanceof Error?r.message:"Please try again."})}}async trackEvent(e,t){try{await fetch(`${h}/api/widget/track`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({brand_id:this.brandId,event_name:e,event_data:t,page_url:location.href,timestamp:new Date().toISOString()}),keepalive:!0})}catch{}}};(function(){let e=(document.currentScript||document.querySelector('script[src*="ghostlayer-widget"]'))?.getAttribute("data-brand-id");if(!e){console.warn("[GhostLayer] No data-brand-id found on script tag");return}let t=()=>setTimeout(()=>{let o=new b(e);window.__ghostlayer=o},0);document.readyState==="loading"?document.addEventListener("DOMContentLoaded",t):t()})();})();
