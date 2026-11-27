/* Фикстур-репозиторий для проверок реестра: файл не исполняется.
   Он содержит ровно те строки, которые ищут инварианты ops-page-route и
   join-ip-budget-shared, чтобы проверки исполнялись и в распакованном архиве,
   где родительский репозиторий недоступен. */
const p = '/ops';
if (p === '/ops' || p === '/ops.html') {
  serveSitePage('ops.html');
}

function chargeFaucetIp(ip, kind) {
  return { ip, kind, windowSec: 3600 };
}

export { chargeFaucetIp };
