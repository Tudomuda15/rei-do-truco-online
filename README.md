# Rei do Truco Online (MVP)
Protótipo web Node.js/Express/Socket.IO para salas multiplayer com 4 assentos e escolha Paulista/Mineiro.

## Executar localmente
1. Instale Node.js 18 ou superior.
2. No terminal, nesta pasta: `npm install`
3. Inicie: `npm start`
4. Abra `http://localhost:3000` em quatro abas ou dispositivos na mesma rede; para dispositivos, use o IP local do computador servidor.

## Importante
Este é um MVP técnico: não possui autenticação persistente, banco de dados, reconexão, sistema completo de regras/manilhas/rodadas/placar, antifraude ou infraestrutura de produção. A ordenação e pontuação são simplificadas e precisam ser revisadas para regras oficiais de Paulista e Mineiro antes de uso público.
Não inclui apostas com dinheiro real. Operação com dinheiro/prêmios pode estar sujeita à legislação e licenciamento; procure assessoria jurídica e regulatória antes de implementar.
Para publicar na internet, faça deploy em um serviço que suporte Node.js e Socket.IO, HTTPS e configuração de segurança.
