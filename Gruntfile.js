module.exports = (grunt) => {
    require('load-grunt-tasks')(grunt);

    grunt.initConfig({
        babel: {
            options: {
                presets: ['es2015']
            },
            dist: {
                files: {
                    'foos.es5.js': 'foos.js'
                }
            }
        }
    });

    grunt.registerTask('default', ['babel']);
};
