import sys, time, torch
sys.path.insert(0, 'face-makeup.PyTorch')
import resnet
resnet.Resnet18.init_weight = lambda self: None  # skip ImageNet download; full ckpt loaded below
from model import BiSeNet

class Wrap(torch.nn.Module):
    def __init__(s, n): super().__init__(); s.n = n
    def forward(s, x): return s.n(x)[0]  # main head only, logits 1x19xHxW

net = BiSeNet(n_classes=19)
sd = torch.load('face-makeup.PyTorch/cp/79999_iter.pth', map_location='cpu')
print(net.load_state_dict(sd))
net.eval()
print('params', sum(p.numel() for p in net.parameters()))
w = Wrap(net).eval()
x = torch.randn(1,3,512,512)
torch.onnx.export(w, x, 'models/zll-bisenet-512.onnx', opset_version=17, input_names=['input'], output_names=['logits'], dynamo=False)
print('exported')
