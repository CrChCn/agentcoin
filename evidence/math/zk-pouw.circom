pragma circom 2.1.9;
// PoUW-factor: c — публичное задание (полупростое), a*b=c — приватное решение.
// Пруф доказывает знание сомножителей, не раскрывая их.
template Mul(){ signal input a; signal input b; signal input c; c === a * b; }
component main { public [c] } = Mul();
