const TAU = 0.5,
    MIN_GAMES_TO_RANK = 20;

firebase.initializeApp({
    apiKey: "AIzaSyCtcTryF9LbZV4gdukC_0z0hZf3ZLt_RuM",
    authDomain: "handyfoosball.firebaseapp.com",
    databaseURL: "https://handyfoosball.firebaseio.com",
    storageBucket: "handyfoosball.appspot.com",
});

angular.module('handy-foos', ['firebase'])
.filter('humanize', () => (value) => moment(value).fromNow())
.factory("FirebaseData", ["$firebaseArray", "$firebaseObject", ($firebaseArray, $firebaseObject) => {
    let rt = firebase.database().ref();

    const COLLECTIONS = [
        'users',
        'games'
    ], OBJECTS = [
        'activeGame',
        'rankingData'
    ];

    let firebaseBuilder = (array, type) => _.reduce(array, (data, dataPoint) => {
        data[dataPoint] = type(rt.child(dataPoint));
        return data;
    }, {});

    return _.extend(firebaseBuilder(COLLECTIONS, $firebaseArray), firebaseBuilder(OBJECTS, $firebaseObject));
}])
.factory("UserService", [() => {
    return {
        initUser(user){
            localStorage.setItem('user', JSON.stringify(user));
            return user;
        },
        getUser(){
            return JSON.parse(localStorage.getItem('user')) || {};
        }
    };
}])
.factory('RankService', ["FirebaseData", "UserService", (FirebaseData, UserService) => {
    let ranker = new glicko2.Glicko2({
        tau: TAU,
        rating: 1500,
        rd: 200,
        vol: 0.06
    });
    return {
        rank() {
            FirebaseData.rankingData.userId = UserService.getUser().$id;
            FirebaseData.rankingData.lastRanked = moment().format();
            FirebaseData.rankingData.$save();
            let users = _.reduce(FirebaseData.users, (users, user) => {
                    user.ratingInfo = user.ratingInfo || {};
                    users[user.$id] = ranker.makePlayer(user.ratingInfo.rating, user.ratingInfo.rd, user.ratingInfo.vol, TAU);
                    return users;
                }, {});

            _.chain(FirebaseData.games)
            .filter(game => game.endTime && !game.ranked)
            .map(game => {
                let winner = game.winner,
                    loser = Number(!game.winner),

                // Increment wins
                winners = _.chain(game.teams[winner])
                    .pick(['player1', 'player2'])
                    .map(FirebaseData.users.$getRecord)
                    .map(p => {debugger; p.wins = (p.wins ? (p.wins+1) : 1); debugger; return p;})
                    .value(),

                // Increment losses
                losers = _.chain(game.teams[loser])
                    .pick(['player1', 'player2'])
                    .map(FirebaseData.users.$getRecord)
                    .map(p => {debugger; p.losses = (p.losses ? (p.losses+1) : 1); debugger; return p;})
                    .value();

                _.chain([winners, losers]).flatten().map(FirebaseData.users.$save).value();

                let race = ranker.makeRace(
                    _.map([game.teams[winner], game.teams[loser]], (team) =>
                        _.map([team.player1, team.player2], playerId => users[playerId])
                    )
                );
                _.reject(race.matches, (match) => match[2] == 0.5) // don't rank teammates
                game.ranked = true;
                FirebaseData.games.$save(game);
            })
            .each(_.bind(ranker.updateRatings, ranker))
            .value();

            _.each(users, (player, userId) => {
                let u = FirebaseData.users.$getRecord(userId);
                u.ratingInfo = {
                    rating: player.getRating(),
                    rd: player.getRd(),
                    vol: player.getVol()
                };
                FirebaseData.users.$save(u);
            });
            FirebaseData.rankingData.child('userId').$remove();
        }
    }
}])
.controller('FoosController', ["$scope", "$firebaseAuth", 'FirebaseData', 'UserService', 'RankService', ($scope, $firebaseAuth, FirebaseData, UserService, RankService) => {
    let getUser = (users, newUser) => {
        if(!(newUser.user.emailVerified && /@handy.*\.com/.test(newUser.user.email))) {
            alert("You are not a handy employee");
            firebase.auth().currentUser.delete();
        } else {
            let user = _.find(users, (u, id) => u.email == newUser.user.email);
            if(!user) {
                let u = _.pick(newUser.user, ['displayName', 'email'])
                FirebaseData.users.$add(u).then(key => UserService.initUser(_.extend(u, {'$id': key.key})));
            } else {
                UserService.initUser(user);
            }
        }
    };

    if(!firebase.auth().currentUser) {
        $firebaseAuth().$signInWithPopup('google').then((result) =>
            FirebaseData.users.$loaded(users => getUser(users, result))
        ).catch((error) => {
            alert(`Authentication failed: ${error}`);
        });
    } else {
        FirebaseData.users.$loaded(users => {
            if(!firebase.auth().currentUser && !localStorage.getItem('user')) {
                $firebaseAuth().$signInWithPopup('google').then((result) =>
                    getUser(users, result)
                ).catch((error) => {
                    alert(`Authentication failed: ${error}`);
                });
            }
        });
    }

    FirebaseData.games.$loaded(games => {
        _.each(games, game => {
            if(_.isString(game.winner)) {
                game.winner = Number(game.winner);
            }
        });
    });

    return {
        name() {
            if(firebase.auth().currentUser) {
                return firebase.auth().currentUser.displayName;
            }
        },
        login() {
            $firebaseAuth().$signInWithRedirect('google').then(result => getUser(FirebaseData.users, result))
            .catch((error) => {
                    alert(`Authentication failed: ${error}`);
            });
        },
        userId: UserService.getUser().$id,
        users: FirebaseData.users,
        liveGame() {
            return _.find(FirebaseData.games, 'live');
        },
        games: FirebaseData.games,
        lastRanked: FirebaseData.rankingData.lastRanked,
        disableButtons() {
            return !!_.chain(FirebaseData.games).filter(game => !game.endTime).map('teams').flatten().map(o => _.values(o)).flatten().find(k => k == UserService.getUser().$id).value();
        },
        createGame() {
            FirebaseData.games.$add({
                teams: [{
                    player1: UserService.getUser().$id,
                    player2: ""
                },{player1: "", player2: ""}]
            });
        },
        createLiveGame() {
            FirebaseData.games.$add({
                live: true,
                teams: [{player1: "", player2: ""},{player1: "", player2: ""}]
            }).catch((err) => {
                debugger;
            });
        }

    };
}])
.directive('game', [() => { return {
    restrict: 'E',
    scope: {
        game: '=',
        userId: '=?',
        disableButtons: '=?',
        isLive: '=?'
    },
    template: `
        <div class='rows'>
            <div class='rows' ng-if="game.endTime">
                <span ng-bind="game.endTime | humanize"></span>
                Winners: Team {{game.winner + 1}}
            </div>
            <span ng-if='game.startTime && !game.endTime'>Started {{game.startTime | humanize}}</span>
            <button class='large confirm' ng-if='gameData.gameFull() && !game.startTime' ng-click='gameData.startGame()' ng-disabled='gameData.hasActiveGame()'>Start Game</button>
            <span ng-if='!gameData.gameFull()'>Pending Game</span>
            Teams:
            <div class='cols'>
                <div class='rows' ng-repeat='team in game.teams'>
                    Team {{$index + 1}}
                    <button class='large confirm' ng-if='game.startTime && !game.endTime' ng-click='gameData.winner($index)'>Winner</button>
                    <span class='centered cols' ng-repeat='(player, userKey) in team'>
                        <div ng-if='userKey' ng-bind="userKey == userId ? 'You' : gameData.getUserByKey(userKey).displayName"></div>
                        <button class='reject' ng-if='userKey == userId && !game.startTime' ng-click='gameData.leaveTeam(team, player)'>Leave Team</button>
                        <button class='confirm' ng-if='!userKey && !isLive && !disableButtons' ng-click='gameData.joinTeam(team, player)'>Join Team</button>
                        <span class='disabled-open' ng-if='!userKey && disableButtons'>OPEN</span>
                    </span>
                </div>
            </div>
        </div>
    `,
    controller: 'GameController as gameData'
};}])
.controller('GameController', ['$scope', 'FirebaseData', 'UserService', ($scope, FirebaseData, UserService) => { return {
    getUserByKey: FirebaseData.users.$getRecord,
    joinTeam(team, player) {
        team[player] = UserService.getUser().$id;
        FirebaseData.games.$save($scope.game);
    },
    leaveTeam(team, player) {
        team[player] = "";
        let emptyGame = _.chain($scope.game.teams)
            .map((team) => _.chain(team)
                            .pick(['player1', 'player2'])
                            .values()
                            .value())
            .flatten()
            .filter()
            .isEmpty()
            .value();
        if(emptyGame) {
            FirebaseData.games.$remove($scope.game);
        } else {
            FirebaseData.games.$save($scope.game);
        }
    },
    hasActiveGame() {
        return !!FirebaseData.activeGame.gameId;
    },
    gameFull() {
        return _.every($scope.game.teams, (team) => !_.isEmpty(team.player1) && !_.isEmpty(team.player2));
    },
    startGame() {
        $scope.game.startTime = moment().format();
        if($scope.game.live) {
            $scope.game.live = false;
        }
        FirebaseData.games.$save($scope.game);
        FirebaseData.activeGame.gameId = $scope.game.$id;
        FirebaseData.activeGame.$save();
    },
    winner(teamIndex) {
        $scope.game.winner = teamIndex;
        $scope.game.endTime = moment().format();
        FirebaseData.games.$save($scope.game);
        FirebaseData.activeGame.$remove();
    }
};}])
.directive('user', [() => { return {
    restrict: 'E',
    scope: {
        user: '=',
        liveGame: '='
    },
    template: `
        <div class='centered outside cols'>
            <span class='rating rows'>
                <span ng-bind='user.ratingInfo.rating'></span>
                <span ng-bind="user.wins + ' / ' + user.losses"></span>
            </span>
            <span class='name' ng-bind='user.displayName'></span>
            <button class='reject' ng-if='liveGame && userData.teamHasSlots(liveGame, 0) && !userData.inGame' ng-click='userData.joinTeam(liveGame, 0)'>Team 1</button>
            <button class='confirm' ng-if='liveGame && userData.teamHasSlots(liveGame, 1) && !userData.inGame' ng-click='userData.joinTeam(liveGame, 1)'>Team 2</button>
        </div>

    `,
    controller: 'UserController as userData'
};}])
.controller('UserController', ["$scope", ($scope) => { return {
    joinTeam(game, team) {
        if(_.isEmpty(game.teams[team].player1)) {
            game.teams[team].player1 = $scope.user.$id;
            this.inGame = true;
            FirebaseData.games.$save(game);
        } else if(_.isEmpty(game.teams[team].player2)) {
            game.teams[team].player2 = $scope.user.$id;
            this.inGame = true;
            FirebaseData.games.$save(game);
        }
    },
    teamHasSlots(game, team) {
        return _.isEmpty(game.teams[team].player1) || _.isEmpty(game.teams[team].player2);
    }
};}])
.run(["FirebaseData", "RankService", "UserService", (FirebaseData, RankService, UserService) => {
    FirebaseData.games.$loaded((games) => {
        if(!FirebaseData.rankingData.userId && _.filter(FirebaseData.games, game => game.endTime && !game.ranked).length > MIN_GAMES_TO_RANK) {
            RankService.rank();
        }
    });
}])
;
