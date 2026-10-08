import numpy as np, cv2, onnxruntime as ort
S = ort.InferenceSession('models/zll-bisenet-512.onnx', providers=['CPUExecutionProvider'])
MEAN=np.array([0.485,0.456,0.406]); STD=np.array([0.229,0.224,0.225])
def parse(bgr):
    x = cv2.resize(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB),(512,512),interpolation=cv2.INTER_LINEAR).astype(np.float32)/255.
    x = ((x-MEAN)/STD).transpose(2,0,1)[None].astype(np.float32)
    lg = S.run(None,{'input':x})[0][0]
    e = np.exp(lg-lg.max(0,keepdims=True)); p = e/e.sum(0,keepdims=True)
    return lg.argmax(0), p
def hsv_replace(img, lab, part, bgr):  # face-makeup.PyTorch hair() verbatim logic
    tar = np.zeros_like(img); tar[:] = bgr
    ih = cv2.cvtColor(img,cv2.COLOR_BGR2HSV); th = cv2.cvtColor(tar,cv2.COLOR_BGR2HSV)
    ih[:,:,0:2] = th[:,:,0:2]
    ch = cv2.cvtColor(ih,cv2.COLOR_HSV2BGR); ch[lab!=part] = img[lab!=part]; return ch
def soft_lab_lip(img, p, hexcol='#b3122e', strength=0.85, feather_px=2.0):
    H,W = img.shape[:2]
    lipP = p[12]+p[13]                                  # soft lip probability, not argmax
    lipP = np.clip((lipP-0.35)/0.4,0,1)                  # gentle threshold ramp
    lipP = cv2.resize(lipP.astype(np.float32),(W,H),interpolation=cv2.INTER_LINEAR)
    s = feather_px*W/512.
    m = cv2.GaussianBlur(lipP,(0,0),s)                  # feather
    r,g,b = [int(hexcol[i:i+2],16) for i in (1,3,5)]
    tl = cv2.cvtColor(np.uint8([[[b,g,r]]]),cv2.COLOR_BGR2LAB).astype(np.float32)[0,0]
    L = cv2.cvtColor(img,cv2.COLOR_BGR2LAB).astype(np.float32)
    w = m>0.5
    mu = L[w].mean(0)
    out = L.copy()
    out[...,0] = L[...,0] + 0.6*(tl[0]-mu[0])          # shift lightness, keep per-pixel texture deltas
    out[...,1] = L[...,1] + (tl[1]-mu[1])              # move chroma to target, keep deltas
    out[...,2] = L[...,2] + (tl[2]-mu[2])
    out = cv2.cvtColor(np.clip(out,0,255).astype(np.uint8),cv2.COLOR_LAB2BGR).astype(np.float32)
    a = (m*strength)[...,None]
    return (img*(1-a)+out*a).astype(np.uint8), m
def blush(img, lab, p, strength=0.35, hexcol='#e05a6a'):
    H,W = img.shape[:2]; sx,sy = W/512., H/512.
    def cen(c):
        ys,xs = np.nonzero(lab==c); return (xs.mean(), ys.mean()) if len(xs) else None
    le,re,nose = cen(4),cen(5),cen(10); lip = cen(12) or cen(13)
    if not (le and re and nose and lip): return img
    eyeY = (le[1]+re[1])/2; mouthY = lip[1]; dy = mouthY-eyeY
    eyeDist = abs(re[0]-le[0])
    yy,xx = np.mgrid[0:512,0:512].astype(np.float32)
    acc = np.zeros((512,512),np.float32)
    for ex in (le[0], re[0]):
        cx = ex + np.sign(ex-nose[0])*0.12*eyeDist; cy = eyeY + 0.55*dy
        rx, ry = 0.38*eyeDist, 0.26*eyeDist
        acc = np.maximum(acc, np.exp(-(((xx-cx)/rx)**2+((yy-cy)/ry)**2)*1.6))   # gaussian falloff, no hard oval edge
    skin = cv2.GaussianBlur(p[1].astype(np.float32),(0,0),3)
    m = cv2.resize(acc*skin,(W,H))
    r,g,b = [int(hexcol[i:i+2],16) for i in (1,3,5)]
    col = np.array([b,g,r],np.float32)/255.; base = img.astype(np.float32)/255.
    sl = np.where(col<=0.5, base-(1-2*col)*base*(1-base), base+(2*col-1)*(np.sqrt(base)-base))  # W3C soft-light
    a = (m*strength)[...,None]
    return np.clip((base*(1-a)+sl*a)*255,0,255).astype(np.uint8)
for name in ['116','6']:
    img = cv2.imread(f'face-makeup.PyTorch/imgs/{name}.jpg'); H,W=img.shape[:2]
    lab,p = parse(img); labF = cv2.resize(lab.astype(np.uint8),(W,H),interpolation=cv2.INTER_NEAREST)
    hard = hsv_replace(hsv_replace(img,labF,12,(46,18,179)),labF,13,(46,18,179))
    soft,m = soft_lab_lip(img,p)
    full = blush(soft,lab,p)
    ys,xs = np.nonzero(m>0.05); y0,y1,x0,x1 = ys.min()-40,ys.max()+40,xs.min()-60,xs.max()+60
    crops = [c[y0:y1,x0:x1] for c in (img,hard,soft)] + [cv2.cvtColor((m[y0:y1,x0:x1]*255).astype(np.uint8),cv2.COLOR_GRAY2BGR)]
    cv2.imwrite(f'demo/{name}_lips_orig_hsvhard_softlab_mask.png', np.hstack(crops))
    cv2.imwrite(f'demo/{name}_full_lips_blush.png', cv2.resize(np.hstack([img,full]),(1024,512)))
# wild framing test: face small in frame -> full-frame parse vs crop-then-parse
img = cv2.imread('face-makeup.PyTorch/imgs/116.jpg'); canvas = np.full((2560,2560,3),128,np.uint8); canvas[768:1792,768:1792]=img
labW,_ = parse(canvas); A = np.isin(labW,[12,13]).sum()
labC,_ = parse(img); B = np.isin(labC,[12,13]).sum()
# map: compare lip pixels inside the face area of the full-frame parse at equal scale
print('wild full-frame lip px (512 grid, face is 40% of frame):', A, ' expected at that scale ~', int(B*0.16), ' crop-parse lip px:', B)
