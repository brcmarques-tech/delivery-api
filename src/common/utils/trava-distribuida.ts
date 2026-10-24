import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

const logger = new Logger('TravaDistribuida');

/**
 * KAN-254 — UM TICK DE SCHEDULER POR VEZ, EM TODA A FROTA
 *
 * Os schedulers são `setInterval` dentro do processo. Com UMA instância da API
 * isso basta. Com duas, os dois processos acordam no mesmo minuto e rodam a
 * MESMA rotina sobre as MESMAS linhas:
 *
 *   - auto-confirmação de entrega: dois ticks disputando os mesmos pedidos;
 *   - expiração de pedido sem pagamento: dupla transição de status e, com ela,
 *     dupla devolução de estoque se a guarda falhar;
 *   - lembrete de agendamento e aviso de bloqueio: a mesma mensagem enviada
 *     duas vezes para o mesmo cliente — o tipo de erro que o cliente vê;
 *   - drenagem de passivos: dois POST /transfers para o mesmo passivo (a
 *     Idempotency-Key cobre, mas é a última linha de defesa, não a primeira).
 *
 * A liquidação de dinheiro tem claim atômico no banco (`isSettled`,
 * `vendorPayablePaidAt`), então ela não paga em dobro nem hoje. O que esta
 * trava resolve é o resto: trabalho duplicado, notificação duplicada e
 * concorrência desnecessária sobre as mesmas linhas.
 *
 * POR QUE ADVISORY LOCK DO POSTGRES, e não Redis: o banco já é compartilhado
 * por todas as instâncias e a trava morre sozinha quando a conexão cai — sem
 * TTL para calibrar e sem o risco clássico de "o dono travou, o TTL venceu, e
 * agora dois acham que são donos". Não é preciso subir nada.
 *
 * CUIDADO QUE O CÓDIGO ABAIXO TOMA: `pg_advisory_lock` é por CONEXÃO. Rodar o
 * lock e o unlock pelo pool comum pegaria conexões diferentes e a trava ficaria
 * presa até o processo morrer. Por isso tudo acontece no mesmo `QueryRunner`.
 */
export async function comTravaDistribuida<T>(
  dataSource: DataSource,
  nome: string,
  tarefa: () => Promise<T>,
): Promise<T | null> {
  const runner = dataSource.createQueryRunner();
  let peguei = false;
  try {
    await runner.connect();
    const [linha] = await runner.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [nome],
    );
    peguei = linha?.ok === true || linha?.ok === 't';
    if (!peguei) {
      // Outra instância está com o tick. Não é erro: é a trava fazendo o
      // trabalho dela. Fica em debug para não poluir o log a cada minuto.
      logger.debug(`tick "${nome}" pulado — outra instancia esta com a trava`);
      return null;
    }
    return await tarefa();
  } catch (err: any) {
    // Falha ao pegar a trava não pode derrubar o scheduler: sem banco, o tick
    // não teria o que fazer mesmo.
    logger.error(`trava "${nome}": ${err?.message || err}`);
    return null;
  } finally {
    if (peguei) {
      try {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [nome]);
      } catch {
        // Conexão já caiu: o Postgres solta a trava sozinho ao encerrar a
        // sessão. Nada a fazer, e nada preso.
      }
    }
    await runner.release().catch(() => {});
  }
}
