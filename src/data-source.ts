import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildPostgresSsl } from './config/db-ssl.config';

/**
 * KAN-261: DataSource usado APENAS pelo CLI do TypeORM (gerar e rodar
 * migrations). A aplicacao continua se configurando pelo `TypeOrmModule` em
 * `app.module.ts` — esta config espelha aquela de proposito.
 *
 * Por que isso existe: o KAN-214 desligou `synchronize` em producao (correto,
 * ele podia gerar DDL destrutivo no deploy), mas o projeto nao tinha nenhum
 * caminho de migration. Na pratica, nenhuma mudanca de schema chegava a
 * producao — nem coluna nova, nem indice. Este arquivo fecha essa lacuna.
 *
 * Uso:
 *   npm run migration:generate -- src/migrations/NomeDaMudanca
 *   npm run migration:run
 *   npm run migration:revert
 */

const databaseUrl = process.env.DATABASE_URL;

export default new DataSource({
  type: 'postgres',
  ...(databaseUrl
    ? {
        url: databaseUrl,
        // KAN-232: valida o certificado do Postgres por padrao (era
        // rejectUnauthorized:false fixo). Espelha app.module.ts.
        ssl: buildPostgresSsl((k) => process.env[k]),
      }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
      }),
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  // Nunca ligar aqui: o CLI deve mexer no schema so via migration.
  synchronize: false,
});
