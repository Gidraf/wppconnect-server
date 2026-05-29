/*
 * factory.ts  – updated to include the 'api' token store type
 *
 * Set  tokenStoreType: 'api'  in config.ts to use your Flask API backend
 * instead of mongodb / redis / file.
 */
import config from '../../config';
import ApiTokenStore from './ApiTokenStore';
import FileTokenStore from './fileTokenStory';
import MongodbTokenStore from './mongodbTokenStory';
import RedisTokenStore from './redisTokenStory';

class Factory {
  public createTokenStory(client: any) {
    const type = config.tokenStoreType;

    if (type === 'api') {
      return new ApiTokenStore(client).tokenStore;
    } else if (type === 'mongodb') {
      return new MongodbTokenStore(client).tokenStore;
    } else if (type === 'redis') {
      return new RedisTokenStore(client).tokenStore;
    } else {
      return new FileTokenStore(client).tokenStore;
    }
  }
}

export default Factory;
