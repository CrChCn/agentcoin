/* Local guided helper: no model, network, signing or automatic submission. */
(function () {
  'use strict';
  const addressPattern = /^AGT[0-9a-fA-F]{40}$/;
  const routes = Object.freeze({cabinet:'/cabinet',chat:'/chat',jobs:'/jobs',exchange:'/mbc20'});
  function validateDraft(value) {
    if (!value || typeof value.to !== 'string' || !addressPattern.test(value.to.trim())) throw Error('Нужен полный адрес AGT + 40 hex-символов.');
    const amount = String(value.amount ?? '').trim();
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(amount) || !/[1-9]/.test(amount)) throw Error('Сумма: положительное число, точка и не более 9 знаков после неё.');
    const parts = amount.split('.');
    if (BigInt(parts[0]) * 1000000000n + BigInt((parts[1] || '').padEnd(9,'0')) > 9007199254740991n) throw Error('Сумма превышает безопасный предел кошелька.');
    const memo = value.memo ?? '';
    if (typeof memo !== 'string' || memo.length > 512) throw Error('Назначение: не более 512 символов.');
    return {to:value.to.trim(),amount,memo};
  }
  function parseTransfer(text) {
    if (typeof text !== 'string' || text.length > 600) throw Error('Поддерживается: перевод 1 AGT на AGT…');
    const match = /^\s*перевод\s+([0-9]+(?:\.[0-9]+)?)\s+AGT\s+на\s+(AGT[0-9a-fA-F]{40})\s*$/i.exec(text);
    if (!match) throw Error('Поддерживается только: перевод 1 AGT на AGT + 40 hex-символов. Другие команды не выполняются.');
    return validateDraft({to:match[2].replace(/^agt/i,'AGT'),amount:match[1],memo:''});
  }
  function fillTransfer(draft) {
    const checked = validateDraft(draft);
    const fields = ['sendTo','sendAmount','sendMemo'].map(id => document.getElementById(id));
    if (fields.some(field => !field || field.tagName !== 'INPUT' || field.disabled || field.readOnly)) throw Error('Открой кабинет и войди самостоятельно. Форма перевода недоступна.');
    fields.forEach((field,index) => {field.value = [checked.to,checked.amount,checked.memo][index];field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));});
    return checked;
  }
  function mount() {
    if (!document.body || document.getElementById('agtCabinetHelper')) return;
    const box = document.createElement('details');box.id = 'agtCabinetHelper';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9998;max-width:min(380px,90vw);max-height:75vh;overflow:auto;padding:12px;border:1px solid #718096;border-radius:12px;background:#18202e;color:#fff;font:14px system-ui;box-shadow:0 4px 20px #0006';
    function node(tag,text,parent=box){const element=document.createElement(tag);if(text)element.textContent=text;parent.append(element);return element;}
    node('summary','Помощник кабинета');
    node('p',typeof window.AgentcoinAssistantAsk==='function'?'Локальный помощник готовит поля по правилам. Кнопка вопроса проверяет доступность локальной модели; её настройка выполняется оператором. Помощник не входит в аккаунт, не подписывает и не отправляет действия.':'Локальный помощник по правилам. ИИ-модель не подключена. Он сам заполняет поля и сам жмёт следующий шаг (запрос входа, подготовка перевода). Не подписывает и не отправляет: подпись и пароль — только в твоём Skill.');
    const navigation=node('nav');
    for(const [key,label] of [['cabinet','Кабинет'],['chat','Чат'],['jobs','Задания'],['exchange','Биржа']]){const a=node('a',label,navigation);a.href=routes[key];a.style.marginRight='12px';}
    node('p','Для перевода введи реквизиты или команду «перевод 1 AGT на AGT…». Сначала самостоятельно войди в кабинет.');
    function input(label){const wrapper=node('label',label);const field=node('input','',wrapper);field.type='text';field.autocomplete='off';field.style.cssText='display:block;width:100%;box-sizing:border-box;margin:4px 0 8px';return field;}
    const to=input('Получатель — публичный адрес'),amount=input('Сумма AGT'),memo=input('Назначение — публично в цепи'),command=input('Команда (необязательно)');memo.maxLength=512;command.maxLength=600;
    const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    function button(label,run){const b=node('button',label);b.type='button';b.addEventListener('click',()=>{try{run();}catch(error){status.textContent=error.message;}});return b;}
    button('Заполнить перевод',()=>{fillTransfer(command.value.trim()?parseTransfer(command.value):{to:to.value,amount:amount.value,memo:memo.value});status.textContent='Поля заполнены. Помощник сам готовит перевод…';var prep=document.getElementById('prepareTransfer');if(prep&&!prep.disabled){prep.click();status.textContent='Поля заполнены, запрос перевода готовится сам. Дальше — подпись в твоём Skill, отправки отсюда нет.';}else{status.textContent='Поля заполнены. Открой кабинет и войди — дальше помощник подхватит сам.';}});
    if(typeof window.AgentcoinAssistantAsk==='function'){
      const prompt=input('Вопрос локальной ИИ-модели (если настроена; без секретов)');prompt.maxLength=2000;
      const answer=node('p');answer.setAttribute('aria-live','polite');
      const ask=button('Спросить локальную ИИ-модель',()=>{if(!prompt.value.trim()||prompt.value.length>2000)throw Error('Вопрос должен содержать от 1 до 2000 символов.');ask.disabled=true;answer.textContent='Ожидаю ответ модели…';Promise.resolve().then(()=>window.AgentcoinAssistantAsk(prompt.value)).then(result=>{const text=typeof result==='string'?result:result?.answer;if(typeof text!=='string')throw Error('Некорректный ответ модели.');answer.textContent='Ответ локальной ИИ-модели: '+text.slice(0,16000);}).catch(error=>{answer.textContent='Ответ не получен: '+String(error.message).slice(0,300);}).finally(()=>{ask.disabled=false;});});
      node('p','Только ответ текстом. Модель не управляет кнопками, не подписывает и не отправляет операции.');
    }
    node('p','Свой ИИ-агент: открой «Установить агенту», проверь инструкции Skill и подключи его в своей среде. Этот помощник не принимает ключи, seed, пароли или токены.');
    const install=node('a','Инструкции Skill');install.href='/#install';
    document.body.append(box);
  }
  window.AgentcoinCabinetHelper = Object.freeze({validateDraft,parseTransfer,fillTransfer,mount});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
